/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { Emitter } from '../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { IChannelServer, IMessagePassingProtocol, ProxyChannel } from '../../../base/parts/ipc/common/ipc.js';
import { BufferedEmitter } from '../../../base/parts/ipc/common/ipc.net.js';
import { Host } from '../../files/vsc-light/hostFileSystemProvider.js';
import { IExtensionHostProcessOptions, ipcExtensionHostStarterChannelName } from '../common/extensionHostStarter.js';

interface HostEvent { id: string; event: string; pid?: number; bytes?: number[]; data?: string; message?: string; code?: number; signal?: string }
class Session {
	readonly disposables = new DisposableStore();
	readonly stdout = this.disposables.add(new Emitter<string>());
	readonly stderr = this.disposables.add(new Emitter<string>());
	readonly message = this.disposables.add(new Emitter<unknown>());
	readonly exit = this.disposables.add(new Emitter<{ code: number; signal: string }>());
	readonly data = new BufferedEmitter<VSBuffer>();
	resolve?: (pid: number) => void;
	reject?: (error: Error) => void;
	started = false;
	exited = false;
}
const sessions = new Map<string, Session>();
const bridge = () => (globalThis as typeof globalThis & { __vscLightHost: Host }).__vscLightHost;
const session = (id: string) => {
	const value = sessions.get(id);
	if (!value) { throw new Error(`Unknown extension host: ${id}`); }
	return value;
};

type Start = (id: string, options: IExtensionHostProcessOptions) => Promise<{ pid: number; protocol: IMessagePassingProtocol }>;
interface Globals {
	__vscLightExtensionHostEvents?: (events: HostEvent[]) => void;
	__vscLightExtensionHostStart?: Start;
}

/** Connects the unchanged extension-host handshake to native Node process messages. */
export function startNativeExtensionHost(id: string, options: IExtensionHostProcessOptions): ReturnType<Start> {
	const start = (globalThis as typeof globalThis & Globals).__vscLightExtensionHostStart;
	if (!start) { throw new Error('Native extension host starter is not registered'); }
	return start(id, options);
}

async function start(id: string, options: IExtensionHostProcessOptions): ReturnType<Start> {
	const state = session(id);
	if (state.started) { throw new Error('Extension host is already started'); }
	state.started = true;
	const pid = await new Promise<number>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Node extension host did not start within 15 seconds')), 15000);
		state.resolve = pid => { clearTimeout(timeout); resolve(pid); };
		state.reject = error => { clearTimeout(timeout); reject(error); };
		bridge().call('extensionHost.start', { id, options }).catch(error => state.reject?.(error));
	}).catch(async error => { await bridge().call('extensionHost.kill', { id }).catch(() => {}); throw error; });
	return { pid, protocol: {
		onMessage: state.data.event,
		send: message => {
			bridge().call('extensionHost.send', { id, bytes: Array.from(message.buffer) }).catch(error => {
				console.error('[vsc-light:extension-host] transport failed', error);
				void bridge().call('extensionHost.kill', { id });
			});
		},
	} };
}

/** Implements the desktop starter service and forwards asynchronous native events. */
export function registerExtensionHostServices(server: IChannelServer<unknown>, host: Host): DisposableStore {
	const disposables = new DisposableStore();
	const globals = globalThis as typeof globalThis & Globals;
	// The IPC server and desktop renderer are separate bundles; share the entry point.
	globals.__vscLightExtensionHostStart = start;
	globals.__vscLightExtensionHostEvents = events => {
		for (const event of events) {
			const state = sessions.get(event.id);
			if (!state) { continue; }
			switch (event.event) {
				case 'started': state.resolve?.(event.pid!); state.resolve = undefined; state.reject = undefined; break;
				case 'data': state.data.fire(VSBuffer.wrap(Uint8Array.from(event.bytes!))); break;
				case 'stdout': state.stdout.fire(event.data!); break;
				case 'stderr': state.stderr.fire(event.data!); break;
				case 'message': state.message.fire(event.data); break;
				case 'error': state.stderr.fire(`${event.message}\n`); state.reject?.(new Error(event.message)); break;
				case 'exit':
				case 'closed':
					state.reject?.(new Error('Node extension host exited during startup'));
					if (!state.exited) { state.exited = true; state.exit.fire({ code: event.code ?? -1, signal: event.signal ?? '' }); }
					if (event.event === 'closed') {
						sessions.delete(event.id);
						disposables.delete(state.disposables);
						state.disposables.dispose();
					}
					break;
			}
		}
	};
	const service = {
		onDynamicStdout: (id: string) => session(id).stdout.event,
		onDynamicStderr: (id: string) => session(id).stderr.event,
		onDynamicMessage: (id: string) => session(id).message.event,
		onDynamicExit: (id: string) => session(id).exit.event,
		async createExtensionHost() {
			const result = await host.call<{ id: string }>('extensionHost.create', {});
			const state = new Session();
			sessions.set(result.id, state); disposables.add(state.disposables);
			return result;
		},
		async start(id: string, options: IExtensionHostProcessOptions) { const result = await startNativeExtensionHost(id, options); return { pid: result.pid }; },
		async enableInspectPort(id: string) { await host.call('extensionHost.inspect', { id }); return true; },
		async kill(id: string) { await host.call('extensionHost.kill', { id }); },
		async waitForExit(id: string, maxWaitTimeMs: number) {
			const state = sessions.get(id);
			if (!state || state.exited) { return; }
			await new Promise<void>(resolve => {
				const listener = state.exit.event(() => finish());
				const timeout = setTimeout(() => finish(), maxWaitTimeMs);
				const finish = () => { clearTimeout(timeout); listener.dispose(); resolve(); };
			});
			if (!state.exited) { await host.call('extensionHost.kill', { id }); }
		},
	};
	server.registerChannel(ipcExtensionHostStarterChannelName, ProxyChannel.fromService(service, disposables, {
		unbufferedEvents: ['onDynamicStdout', 'onDynamicStderr', 'onDynamicMessage', 'onDynamicExit'],
	}));
	disposables.add(toDisposable(() => {
		delete globals.__vscLightExtensionHostEvents;
		delete globals.__vscLightExtensionHostStart;
		for (const id of sessions.keys()) { void host.call('extensionHost.kill', { id }); }
		sessions.clear();
	}));
	console.info('[vsc-light:ipc] registered channel extensionHostStarter');
	return disposables;
}
