/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { IChannelServer } from '../../../../base/parts/ipc/common/ipc.js';
import { Host } from '../../../../platform/files/vsc-light/hostFileSystemProvider.js';
import { IBaseSerializableStorageRequest, ISerializableCompareAndSwapRequest, ISerializableItemsChangeEvent } from '../../../../platform/storage/common/storageIpc.js';

/** Implements the upstream storage protocol using atomically replaced native JSON files. */
export function registerStorageServices(server: IChannelServer<unknown>, host: Host): IDisposable {
	const disposables = new DisposableStore();
	const emitters = new Map<string, Emitter<ISerializableItemsChangeEvent>>();
	function emitter(arg: IBaseSerializableStorageRequest): Emitter<ISerializableItemsChangeEvent> {
		const scope = arg.workspace ? `workspace:${arg.workspace.id}` : arg.profile ? `profile:${arg.profile.id}` : arg.applicationShared ? 'application-shared' : 'application';
		let result = emitters.get(scope);
		if (!result) {
			result = disposables.add(new Emitter<ISerializableItemsChangeEvent>());
			emitters.set(scope, result);
		}
		return result;
	}

	async function call(command: string, arg: IBaseSerializableStorageRequest): Promise<unknown> {
		switch (command) {
			case 'getItems': return host.call('storage.getItems', arg);
			case 'getValue': return (await host.call<string | null>('storage.getValue', arg)) ?? undefined;
			case 'getFallbackApplicationStorageItems': return host.call('storage.getItems', {});
			case 'updateItems': {
				const changes = await host.call<ISerializableItemsChangeEvent>('storage.updateItems', arg);
				if (changes.changed?.length || changes.deleted?.length) { emitter(arg).fire(changes); }
				return;
			}
			case 'compareAndSwap': {
				const request = arg as ISerializableCompareAndSwapRequest;
				const result = await host.call<{ swapped: boolean; currentValue: string | null }>('storage.compareAndSwap', request);
				if (result.swapped) { emitter(arg).fire({ changed: [[request.key, request.newValue]] }); }
				return { swapped: result.swapped, currentValue: result.currentValue ?? undefined };
			}
			case 'optimize': return; // No database compaction needed for JSON files.
			case 'isUsed': return false; // This host holds no storage database files open.
			default: throw new Error(`Unsupported VSC-Light storage command: ${command}`);
		}
	}

	server.registerChannel('storage', {
		listen: <T>(_context: unknown, event: string, arg: IBaseSerializableStorageRequest) => {
			if (event !== 'onDidChangeStorage') { throw new Error(`Unsupported VSC-Light storage event: ${event}`); }
			return emitter(arg).event as Event<T>;
		},
		call: async <T>(_context: unknown, command: string, arg: IBaseSerializableStorageRequest) => {
			try {
				return await call(command, arg) as T;
			} catch (error) {
				console.error(`[vsc-light:storage] ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}
		},
	});
	disposables.add({ dispose: () => emitters.clear() });
	console.info('[vsc-light:ipc] registered channel storage');
	return disposables;
}
