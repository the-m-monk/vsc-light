/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { VSBuffer } from '../../../base/common/buffer.js';
import { PersistentProtocol } from '../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../base/parts/ipc/node/ipc.net.js';
import type { IExtensionHostProcessOptions } from '../common/extensionHostStarter.js';

type Request = { operation: 'start'; options: IExtensionHostProcessOptions }
	| { operation: 'send'; bytes: number[] }
	| { operation: 'inspect' | 'kill' };

// This helper owns one Node extension host. Only NDJSON bridge messages go to stdout.
const root = dirname(fileURLToPath(import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'vsc-light-exthost-'));
const pipe = join(directory, 'ipc.sock');
let child: ChildProcess | undefined;
let protocol: PersistentProtocol | undefined;
let connection: Socket | undefined;
let stopping = false;
let disconnecting = false;
let outputClosed = false;
const emit = (event: string, data: object) => {
	if (outputClosed) { return; }
	if (!process.stdout.write(`${JSON.stringify({ event, ...data })}\n`)) {
		connection?.pause(); child?.stdout?.pause(); child?.stderr?.pause();
	}
};
process.stdout.on('drain', () => { connection?.resume(); child?.stdout?.resume(); child?.stderr?.resume(); });
const server = createServer(socket => {
	if (connection) { socket.destroy(); return; }
	connection = socket;
	server.close();
	protocol = new PersistentProtocol({ socket: new NodeSocket(socket, 'vsc-light-extension-host') });
	protocol.onMessage(message => emit('data', { bytes: Array.from(message.buffer) }));
});
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
const stop = () => {
	if (stopping) { return; }
	stopping = true;
	child?.kill('SIGKILL');
	protocol?.dispose(); connection?.destroy(); server.close();
	void rm(directory, { recursive: true, force: true }).finally(() => process.exit());
};
const disconnect = () => {
	if (stopping || disconnecting) { return; }
	disconnecting = true;
	// Reload/close removes the renderer. Give extensions time to deactivate.
	if (protocol && child) {
		protocol.send(VSBuffer.wrap(Uint8Array.of(3))); // MessageType.Terminate
		setTimeout(stop, 6000).unref();
	} else {
		stop();
	}
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('uncaughtException', error => { emit('error', { message: error.stack ?? error.message }); stop(); });
process.stdout.on('error', () => {
	outputClosed = true;
	connection?.resume(); child?.stdout?.resume(); child?.stderr?.resume();
	disconnect();
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', disconnect);
input.on('line', line => {
	try {
		const request = JSON.parse(line) as Request;
		switch (request.operation) {
			case 'start': {
				if (child) { throw new Error('Extension host is already started'); }
				// Respect the environment already sanitized by the workbench.
				const env = { ...request.options.env };
				delete env.VSCODE_WILL_SEND_MESSAGE_PORT;
				delete env.VSCODE_EXTHOST_WILL_SEND_SOCKET;
				delete env.ELECTRON_RUN_AS_NODE;
				delete env.VSCODE_DEV; // This process uses the bundled NLS messages.
				env.VSCODE_EXTHOST_IPC_HOOK = pipe;
				env.VSCODE_ESM_ENTRYPOINT = 'vs/workbench/api/node/extensionHostProcess';
				env.VSCODE_HANDLES_UNCAUGHT_ERRORS = 'true';
				env.VSCODE_PARENT_PID = String(process.pid);
				env.VSCODE_NLS_CONFIG = JSON.stringify({ resolvedLanguage: 'en', defaultMessagesFile: join(root, 'nls.messages.json') });
				child = spawn(process.execPath, [...(request.options.execArgv ?? []), join(root, 'bootstrap-fork.js'), '--skipWorkspaceStorageLock'], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
				child.on('spawn', () => emit('started', { pid: child!.pid }));
				child.stdout!.on('data', chunk => emit('stdout', { data: chunk.toString() }));
				child.stderr!.on('data', chunk => emit('stderr', { data: chunk.toString() }));
				child.on('message', data => emit('message', { data }));
				child.on('error', error => { emit('error', { message: error.message }); stop(); });
				child.on('exit', (code, signal) => { emit('exit', { code: code ?? -1, signal: signal ?? '' }); stop(); });
				break;
			}
			case 'send':
				if (!protocol) { throw new Error('Extension host has not connected'); }
				protocol.send(VSBuffer.wrap(Uint8Array.from(request.bytes))); break;
			case 'inspect': child?.kill('SIGUSR1'); break;
			case 'kill': stop(); break;
			default: throw new Error('Unknown extension host operation');
		}
	} catch (error) {
		emit('error', { message: String(error) }); stop();
	}
});
