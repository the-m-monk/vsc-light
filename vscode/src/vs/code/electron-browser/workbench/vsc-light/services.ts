/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { DefaultURITransformer, IURITransformer } from '../../../../base/common/uriIpc.js';
import { IChannelServer } from '../../../../base/parts/ipc/common/ipc.js';
import { LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../../../platform/files/common/diskFileSystemProviderClient.js';
import { AbstractDiskFileSystemProviderChannel, ISessionFileWatcher } from '../../../../platform/files/common/diskFileSystemProviderServer.js';
import { FileService } from '../../../../platform/files/common/fileService.js';
import { IFileChange, IWatchOptions } from '../../../../platform/files/common/files.js';
import { Host, HostFileSystemProvider } from '../../../../platform/files/vsc-light/hostFileSystemProvider.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { registerManagedSettings } from './managedSettings.js';

/** Supplies local URIs and watcher policy to the unchanged upstream disk channel. */
class HostDiskFileSystemProviderChannel extends AbstractDiskFileSystemProviderChannel<unknown> {
	protected getUriTransformer(_context: unknown): IURITransformer { return DefaultURITransformer; }
	protected transformIncoming(_transformer: IURITransformer, resource: UriComponents): URI { return URI.revive(resource); }
	protected createSessionFileWatcher(_transformer: IURITransformer, _emitter: Emitter<IFileChange[] | string>): ISessionFileWatcher {
		const watches = new DisposableStore();
		return {
			watch: (_request: number, resource: URI, opts: IWatchOptions) => watches.add(this.provider.watch(resource, opts)),
			dispose: () => watches.dispose(),
		};
	}
}

/** Constructs only the host services needed by the upstream local filesystem channel. */
export function registerVscLightServices(server: IChannelServer<unknown>): IDisposable {
	const host = (globalThis as typeof globalThis & { __vscLightHost?: Host }).__vscLightHost;
	if (!host) { throw new Error('VSC-Light host RPC was not installed by preload'); }
	const disposables = new DisposableStore();
	const logService = disposables.add(new NullLogService());
	const fileService = disposables.add(new FileService(logService));
	const provider = disposables.add(new HostFileSystemProvider(host));
	disposables.add(fileService.registerProvider(Schemas.file, provider));
	const channel = disposables.add(new HostDiskFileSystemProviderChannel(provider, logService));
	server.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, channel);
	console.info('[vsc-light:ipc] registered channel localFilesystem');
	disposables.add(registerManagedSettings(server, fileService, logService));
	return disposables;
}
