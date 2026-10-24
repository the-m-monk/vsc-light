/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionGalleryService, IAllowedExtensionsService } from '../../../../platform/extensionManagement/common/extensionManagement.js';

/** Makes the renderer's existing gallery service available to native install/dependency requests. */
export function registerGalleryBridge(instantiation: IInstantiationService): void {
	(globalThis as typeof globalThis & { __vscLightGallery: IExtensionGalleryService }).__vscLightGallery =
		instantiation.invokeFunction(accessor => accessor.get(IExtensionGalleryService));
	(globalThis as typeof globalThis & { __vscLightAllowedExtensions: IAllowedExtensionsService }).__vscLightAllowedExtensions =
		instantiation.invokeFunction(accessor => accessor.get(IAllowedExtensionsService));
}
