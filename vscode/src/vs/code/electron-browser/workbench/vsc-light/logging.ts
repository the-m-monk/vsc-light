/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IChannelServer } from '../../../../base/parts/ipc/common/ipc.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { FileLoggerService } from '../../../../platform/log/common/fileLog.js';
import { isLogLevel, log, LogLevel } from '../../../../platform/log/common/log.js';

/** Provides the single workbench window with the upstream file-backed logger service. */
export function registerLoggingServices(server: IChannelServer<unknown>, fileService: IFileService): IDisposable {
	const service = new FileLoggerService(LogLevel.Debug, URI.file('/tmp/vsc-light-user-data/logs'), fileService);
	server.registerChannel('logger', {
		listen: (_context: unknown, event: string): Event<any> => {
			switch (event) {
				case 'onDidChangeLoggers': return service.onDidChangeLoggers;
				case 'onDidChangeLogLevel': return service.onDidChangeLogLevel;
				case 'onDidChangeVisibility': return service.onDidChangeVisibility;
				default: throw new Error(`Event not found: ${event}`);
			}
		},
		call: async (_context: unknown, command: string, args: any[] = []): Promise<any> => {
			switch (command) {
				case 'createLogger': service.createLogger(URI.revive(args[0]), args[1]); return;
				case 'log': {
					const logger = service.getLogger(URI.revive(args[0]));
					if (logger) { for (const [level, message] of args[1]) { log(logger, level, message); } }
					return;
				}
				case 'consoleLog': {
					const method = args[0] === LogLevel.Error ? console.error : args[0] === LogLevel.Warning ? console.warn : args[0] === LogLevel.Info ? console.info : console.log;
					method.call(console, ...args[1]); return;
				}
				case 'setLogLevel': return isLogLevel(args[0]) ? service.setLogLevel(args[0]) : service.setLogLevel(URI.revive(args[0]), args[1]);
				case 'setVisibility': return service.setVisibility(URI.revive(args[0]), args[1]);
				case 'registerLogger': return service.registerLogger({ ...args[0], resource: URI.revive(args[0].resource) });
				case 'deregisterLogger': return service.deregisterLogger(URI.revive(args[0]));
				default: throw new Error(`Call not found: ${command}`);
			}
		},
	});
	return service;
}
