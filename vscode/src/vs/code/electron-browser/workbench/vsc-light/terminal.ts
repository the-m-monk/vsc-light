/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IChannelServer } from '../../../../base/parts/ipc/common/ipc.js';
import { Host } from '../../../../platform/files/vsc-light/hostFileSystemProvider.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';

interface NativeEvent { id: number; type: 'data' | 'exit'; bytes?: number[]; code?: number }
interface Session { config: IShellLaunchConfig; ready: boolean; pending: NativeEvent[]; decoder: TextDecoder; cwd?: string; pendingBytes: number; acknowledgements: { chars: number; bytes: number }[] }

/** Adapts the localPty protocol to Linux PTYs owned by the native host. */
export function registerTerminalServices(server: IChannelServer<unknown>, host: Host): IDisposable {
	const disposables = new DisposableStore();
	const events = new Map<string, Emitter<unknown>>();
	const sessions = new Map<number, Session>();
	function event(name: string): Emitter<unknown> {
		let emitter = events.get(name);
		if (!emitter) { emitter = disposables.add(new Emitter<unknown>()); events.set(name, emitter); }
		return emitter;
	}
	function receive(batch: NativeEvent[]) {
		for (const entry of batch) {
			const session = sessions.get(entry.id);
			if (!session) { continue; }
			if (!session.ready) { session.pending.push(entry); continue; }
			if (entry.type === 'data') {
				session.pendingBytes += entry.bytes?.length ?? 0;
				const data = session.decoder.decode(new Uint8Array(entry.bytes), { stream: true });
				if (data) {
					session.acknowledgements.push({ chars: data.length, bytes: session.pendingBytes });
					session.pendingBytes = 0;
					event('onProcessData').fire({ id: entry.id, event: data });
				}
			} else {
				const tail = session.decoder.decode();
				if (tail) { event('onProcessData').fire({ id: entry.id, event: tail }); }
				event('onProcessExit').fire({ id: entry.id, event: entry.code });
				sessions.delete(entry.id);
			}
		}
	}
	const globals = globalThis as typeof globalThis & { __vscLightTerminalEvents?: typeof receive };
	globals.__vscLightTerminalEvents = receive;
	disposables.add({ dispose: () => {
		if (globals.__vscLightTerminalEvents === receive) { delete globals.__vscLightTerminalEvents; }
		sessions.clear();
	} });
	function property(id: number, type: string, value: unknown) { event('onDidChangeProperty').fire({ id, property: { type, value } }); }

	async function call(command: string, args: unknown[]): Promise<unknown> {
		const id = args[0] as number;
		switch (command) {
			case 'getDefaultSystemShell': return host.call('terminal.getDefaultSystemShell', {});
			case 'getEnvironment': return host.call('terminal.getEnvironment', {});
			case 'getProfiles': return host.call('terminal.getProfiles', { profiles: args[1], defaultProfile: args[2] });
			case 'createProcess': {
				const [config, cwd, cols, rows, , env] = args as [IShellLaunchConfig, string, number, number, unknown, object];
				const id = await host.call<number>('terminal.createProcess', { shellLaunchConfig: config, cwd, cols, rows, env });
				sessions.set(id, { config, ready: false, pending: [], decoder: new TextDecoder(), pendingBytes: 0, acknowledgements: [] });
				return id;
			}
			case 'start': {
				const session = sessions.get(id);
				if (!session) { return { message: 'Terminal no longer exists' }; }
				try {
					const ready = await host.call<{ pid: number; cwd: string }>('terminal.start', { id });
					session.cwd = ready.cwd;
					property(id, 'initialCwd', ready.cwd);
					property(id, 'cwd', ready.cwd);
					property(id, 'resolvedShellLaunchConfig', session.config);
					property(id, 'title', session.config.name ?? session.config.executable?.split('/').pop() ?? 'Shell');
					event('onProcessReady').fire({ id, event: ready });
					session.ready = true;
					receive(session.pending.splice(0));
					return;
				} catch (error) {
					sessions.delete(id);
					await host.call('terminal.shutdown', { id });
					return { message: error instanceof Error ? error.message : String(error) };
				}
			}
			case 'input': return host.call('terminal.input', { id, data: args[1] });
			case 'processBinary': return host.call('terminal.processBinary', { id, bytes: Array.from(args[1] as string, character => character.charCodeAt(0) & 255) });
			case 'resize': return host.call('terminal.resize', { id, cols: args[1], rows: args[2] });
			case 'sendSignal': return host.call('terminal.sendSignal', { id, signal: args[1] });
			case 'getCwd': return host.call('terminal.getCwd', { id });
			case 'getInitialCwd': return host.call('terminal.getInitialCwd', { id });
			case 'shutdown':
			case 'detachFromProcess': return host.call('terminal.shutdown', { id });
			case 'shutdownAll':
			case 'restartPtyHost': return host.call('terminal.shutdownAll', {});
			case 'refreshProperty': {
				const type = args[1] as string;
				let value: unknown;
				if (type === 'cwd' || type === 'initialCwd') { value = await host.call(type === 'cwd' ? 'terminal.getCwd' : 'terminal.getInitialCwd', { id }); }
				else if (type === 'resolvedShellLaunchConfig') { value = sessions.get(id)?.config; }
				else if (type === 'hasChildProcesses') { value = await host.call('terminal.hasChildProcesses', { id }); }
				property(id, type, value);
				return value;
			}
			case 'updateProperty': property(id, args[1] as string, args[2]); return;
			case 'updateTitle': property(id, 'title', args[1]); return;
			case 'clearBuffer': event('onProcessData').fire({ id, event: '\x1b[3J\x1b[H\x1b[2J' }); return;
			case 'getTerminalLayoutInfo':
			case 'getRevivedPtyNewId':
			case 'requestDetachInstance': return undefined;
			case 'serializeTerminalState': return JSON.stringify({ version: 1, state: [] });
			case 'getPerformanceMarks':
			case 'getLatency':
			case 'listProcesses': return [];
			case 'getWslPath': return args[0];
			case 'acknowledgeDataEvent': {
				const acknowledgements = sessions.get(id)?.acknowledgements;
				let chars = args[1] as number;
				let bytes = 0;
				while (chars > 0 && acknowledgements?.length) {
					const chunk = acknowledgements[0];
					if (chars < chunk.chars) { chunk.chars -= chars; break; }
					chars -= chunk.chars;
					bytes += chunk.bytes;
					acknowledgements.shift();
				}
				if (bytes) { return host.call('terminal.acknowledgeDataEvent', { id, bytes }); }
				return;
			}
			case 'setTerminalLayoutInfo':
			case 'reviveTerminalProcesses':
			case 'setUnicodeVersion':
			case 'setNextCommandId':
			case 'orphanQuestionReply':
			case 'updateIcon':
			case 'reduceConnectionGraceTime':
			case 'acceptDetachInstanceReply':
			case 'acceptPtyHostResolvedVariables':
			case 'refreshIgnoreProcessNames':
			case 'installAutoReply':
			case 'uninstallAllAutoReplies': return;
			default: throw new Error(`Unsupported VSC-Light terminal command: ${command}`);
		}
	}
	server.registerChannel('localPty', {
		listen: <T>(_context: unknown, name: string) => event(name).event as Event<T>,
		call: async <T>(_context: unknown, command: string, args: unknown[] = []) => await call(command, args) as T,
	});
	console.info('[vsc-light:ipc] registered channel localPty');
	return disposables;
}
