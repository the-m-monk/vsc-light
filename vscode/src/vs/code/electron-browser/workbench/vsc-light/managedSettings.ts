/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { isLinux } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannelServer } from '../../../../base/parts/ipc/common/ipc.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { MANAGED_SETTINGS_LINUX_FILE_PATH, NullNativeManagedSettingsService } from '../../../../platform/policy/common/copilotManagedSettings.js';
import { FileManagedSettingsChannel } from '../../../../platform/policy/common/fileManagedSettingsIpc.js';
import { FileManagedSettingsService } from '../../../../platform/policy/common/fileManagedSettingsService.js';
import { NativeManagedSettingsChannel } from '../../../../platform/policy/common/nativeManagedSettingsIpc.js';

/** Uses the same managed-settings services as upstream Electron main on Linux. */
export function registerManagedSettings(server: IChannelServer<unknown>, fileService: IFileService, logService: ILogService): IDisposable {
	if (!isLinux) {
		throw new Error('VSC-Light managed settings currently support the Linux host only');
	}

	const disposables = new DisposableStore();
	// Upstream uses native MDM only on Windows/macOS; Linux uses this null service.
	const nativeSettings = new NullNativeManagedSettingsService();
	const nativeChannel = disposables.add(new NativeManagedSettingsChannel(nativeSettings));
	server.registerChannel('nativeManagedSettings', nativeChannel);
	console.info('[vsc-light:ipc] registered channel nativeManagedSettings');

	// Keep the real upstream Linux path and parsing behavior, including missing-file handling.
	const fileSettings = disposables.add(new FileManagedSettingsService(URI.file(MANAGED_SETTINGS_LINUX_FILE_PATH), fileService, logService));
	const fileChannel = disposables.add(new FileManagedSettingsChannel(fileSettings));
	server.registerChannel('fileManagedSettings', fileChannel);
	console.info('[vsc-light:ipc] registered channel fileManagedSettings');

	return disposables;
}
