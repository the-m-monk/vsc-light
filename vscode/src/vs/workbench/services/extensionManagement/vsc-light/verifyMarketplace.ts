/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IExtensionGalleryService } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionType } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService, LifecyclePhase } from '../../lifecycle/common/lifecycle.js';
import { IExtensionManagementServerService } from '../common/extensionManagement.js';
import { IExtensionsWorkbenchService } from '../../../contrib/extensions/common/extensions.js';
import { IWebviewService } from '../../../contrib/webview/browser/webview.js';
import { IExtensionService } from '../../extensions/common/extensions.js';

/** Opt-in live API test; run with isolated HOME/XDG directories. */
export async function verifyMarketplace(instantiation: IInstantiationService): Promise<void> {
	await instantiation.invokeFunction(accessor => accessor.get(ILifecycleService)).when(LifecyclePhase.Restored);
	const gallery = instantiation.invokeFunction(accessor => accessor.get(IExtensionGalleryService));
	const management = instantiation.invokeFunction(accessor => accessor.get(IExtensionManagementServerService)).localExtensionManagementServer!.extensionManagementService;
	const workbench = instantiation.invokeFunction(accessor => accessor.get(IExtensionsWorkbenchService));
	await instantiation.invokeFunction(accessor => accessor.get(IExtensionService)).whenInstalledExtensionsRegistered();
	const local = await workbench.queryLocal();
	const restart = local.filter(extension => extension.runtimeState);
	console.info(`[vsc-light:verify] startup extensions=${local.length} restartRequired=${restart.length}`);
	if (restart.length) { throw new Error(`Unexpected startup restart requirements: ${restart.map(e => e.identifier.id).join(', ')}`); }
	const webviews = instantiation.invokeFunction(accessor => accessor.get(IWebviewService));
	await workbench.open('jdinhlife.gruvbox');
	const deadline = Date.now() + 15000;
	while (![...webviews.webviews].some(view => (view.intrinsicContentSize.get()?.height ?? 0) > 0)) {
		if (Date.now() > deadline) { throw new Error('Extension details webview failed to render'); }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	console.info('[vsc-light:verify] extension details editor rendered its webview');
	console.info('[vsc-light:verify] marketplace querying Open VSX');
	const page = await gallery.query({ text: 'gruvbox', pageSize: 3 }, CancellationToken.None);
	if (!page.firstPage.length) { throw new Error('Marketplace returned no search results'); }
	console.info(`[vsc-light:verify] marketplace search succeeded count=${page.firstPage.length}`);
	const extensions = await gallery.getExtensions([{ id: 'jdinhlife.gruvbox' }], { compatible: true, targetPlatform: await management.getTargetPlatform() }, CancellationToken.None);
	const extension = extensions[0];
	if (!extension) { throw new Error('Marketplace extension metadata was not found'); }
	const manifest = await gallery.getManifest(extension, CancellationToken.None);
	if (!manifest || manifest.main || manifest.browser) { throw new Error('Smoke test expected a declarative theme package'); }
	const readme = await gallery.getReadme(extension, CancellationToken.None);
	if (!readme.length) { throw new Error('Marketplace README was empty'); }
	console.info(`[vsc-light:verify] marketplace details succeeded id=${extension.identifier.id} readmeBytes=${readme.length}`);
	const installed = await management.installFromGallery(extension, { isMachineScoped: true });
	try {
		const users = await management.getInstalled(ExtensionType.User);
		if (!users.some(item => item.identifier.id === installed.identifier.id)) { throw new Error('Installed package was not persisted'); }
		console.info(`[vsc-light:verify] marketplace install succeeded id=${installed.identifier.id} version=${installed.manifest.version}`);
	} finally { await management.uninstall(installed); }
	const remaining = await management.getInstalled(ExtensionType.User);
	if (remaining.some(item => item.identifier.id === installed.identifier.id)) { throw new Error('Package was not uninstalled'); }
	console.info('[vsc-light:verify] marketplace succeeded: search, metadata, README, VSIX download, install, persisted listing, uninstall');
}
