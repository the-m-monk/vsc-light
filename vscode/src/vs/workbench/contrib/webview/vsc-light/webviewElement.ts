/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WebviewElement } from '../browser/webviewElement.js';

/** Use upstream iframe messaging without Electron's unavailable webContents APIs. */
export class HostWebviewElement extends WebviewElement {
	protected override webviewContentEndpoint(origin: string): string {
		return `vscode-webview://${origin}`;
	}
}
