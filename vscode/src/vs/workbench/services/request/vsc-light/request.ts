/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { bufferToStream, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { canceled } from '../../../../base/common/errors.js';
import { IRequestContext, IRequestOptions, IHeaders } from '../../../../base/parts/request/common/request.js';
import { Host } from '../../../../platform/files/vsc-light/hostFileSystemProvider.js';

let nextRequest = 1;

/** Uses native HTTP so custom app origins can access gallery APIs and binary assets. */
export async function request(options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> {
	if (token.isCancellationRequested) { throw canceled(); }
	const host = (globalThis as typeof globalThis & { __vscLightHost: Host }).__vscLightHost;
	const requestId = `request-${Date.now()}-${nextRequest++}`;
	const headers = { ...options.headers };
	if (options.user || options.password) { headers.Authorization = `Basic ${encodeBase64(VSBuffer.fromString(`${options.user ?? ''}:${options.password ?? ''}`))}`; }
	const subscription = token.onCancellationRequested(() => { host.call('network.cancel', { requestId }).catch(() => {}); });
	try {
		const response = await host.call<{ statusCode: number; headers: IHeaders; body: Uint8Array }>('network.request', { ...options, headers, requestId });
		if (token.isCancellationRequested) { throw canceled(); }
		return { res: { statusCode: response.statusCode, headers: response.headers }, stream: bufferToStream(VSBuffer.wrap(response.body)) };
	} catch (error) {
		if (token.isCancellationRequested) { throw canceled(); }
		throw error;
	} finally { subscription.dispose(); }
}
