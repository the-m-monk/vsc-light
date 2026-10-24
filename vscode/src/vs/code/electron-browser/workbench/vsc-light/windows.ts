/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { IChannelServer, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Host } from '../../../../platform/files/vsc-light/hostFileSystemProvider.js';

/** Minimal single-window support; native selection stays on the GTK main thread. */
export function registerWindowServices(server: IChannelServer<unknown>, host: Host): IDisposable {
	const disposables = new DisposableStore();
	// Record the Explorer click without instantiating any workbench services ourselves.
	const logActivityBarClick = (event: MouseEvent) => {
		const target = event.target;
		if (!(target instanceof Element) || !target.closest('.activitybar')) { return; }
		const action = target.closest('.action-item');
		const label = action?.querySelector('[aria-label]')?.getAttribute('aria-label');
		console.info(`[vsc-light:window] activity bar click at=${Date.now()} label=${label ?? action?.textContent ?? '(unknown)'}`);
	};
	globalThis.document.addEventListener('click', logActivityBarClick, true);
	disposables.add({ dispose: () => globalThis.document.removeEventListener('click', logActivityBarClick, true) });
	async function openFolder(resource: UriComponents): Promise<void> {
		const uri = URI.revive(resource);
		console.info(`[vsc-light:window] openFolder called: scheme=${uri.scheme} authority=${uri.authority || '(none)'} path=${uri.fsPath}`);
		if (uri.scheme !== 'file' || uri.authority) {
			throw new Error('VSC-Light currently supports local folders only');
		}
		await host.call('window.openFolder', { path: uri.fsPath });
	}

	async function nativeCall(command: string, args: unknown[] = []): Promise<unknown> {
		if (command === 'pickFolderAndOpen' || command === 'openWindow') {
			console.info(`[vsc-light:window] nativeHost ${command} called; args=${JSON.stringify(args)}`);
		}
		// NativeHostService prepends its windowId to all method arguments.
		const [, options] = args as [number, { defaultPath?: string; remoteAuthority?: string } | undefined];
		switch (command) {
			case 'getWindowCount': return 1;
			case 'getActiveWindowId': return 1;
			case 'getWindows': return [{ id: 1, title: globalThis.document.title }];
			case 'getOSColorScheme': return { dark: false, highContrast: false };
			case 'isGPUCompositingEnabled': return false;
			case 'isWindowAlwaysOnTop': return false;
			case 'isAdmin': return false;
			case 'getAgentHostEditorState': return {
				revision: 0,
				editorSessionCount: 0,
				sessions: [],
				lastShown: undefined,
				lastCopilotHarnessIntroductionSessionCount: undefined,
				invitation: undefined,
			};
			case 'syncSystemWideKeybindings': return { failed: [] };
			case 'updateWindowControls':
			case 'setMinimumSize':
			case 'notifyReady':
			case 'saveWindowSplash':
			case 'setBackgroundThrottling': return;
			case 'pickFolderAndOpen': {
				if (options?.remoteAuthority) { throw new Error('Remote folders are not supported'); }
				console.info('[vsc-light:window] opening native folder picker');
				const path = await host.call<string | null>('dialog.pickFolder', { defaultPath: options?.defaultPath });
				console.info(`[vsc-light:window] folder picker returned: ${path ?? '(cancelled)'}`);
				if (path !== null) { await openFolder(URI.file(path)); }
				return;
			}
			case 'openWindow': {
				const toOpen = args[1] as { folderUri?: UriComponents }[] | undefined;
				if (!Array.isArray(toOpen) || toOpen.length !== 1 || !toOpen[0].folderUri) {
					throw new Error('VSC-Light currently opens one local folder in the current window');
				}
				return openFolder(toOpen[0].folderUri);
			}
			default: throw new Error(`Unsupported VSC-Light nativeHost command: ${command}`);
		}
	}
	server.registerChannel('nativeHost', {
		listen: () => Event.None,
		call: async <T>(_context: unknown, command: string, args?: unknown[]) => {
			try {
				return await nativeCall(command, args) as T;
			} catch (error) {
				const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
				console.error(`[vsc-light:window] nativeHost ${command} FAILED at=${Date.now()} ${detail}`);
				throw error;
			}
		},
	});

	// Expose the current folder to the default-path and recent-folder consumers.
	server.registerChannel('workspaces', ProxyChannel.fromService({
		onDidChangeRecentlyOpened: Event.None,
		async getRecentlyOpened() {
			const state = await host.call<{ folder: string | null }>('window.getState', {});
			return { workspaces: state.folder ? [{ folderUri: URI.file(state.folder) }] : [], files: [] };
		},
		async getDirtyWorkspaces() { return []; },
	}, disposables));
	console.info('[vsc-light:ipc] registered channels nativeHost, workspaces');
	return disposables;
}
