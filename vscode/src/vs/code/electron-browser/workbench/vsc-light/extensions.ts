/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannelServer } from '../../../../base/parts/ipc/common/ipc.js';
import { Host } from '../../../../platform/files/vsc-light/hostFileSystemProvider.js';
import { IExtensionGalleryService, IAllowedExtensionsService, IGalleryExtension, ILocalExtension, InstallOptions, InstallOperation, isTargetPlatformCompatible } from '../../../../platform/extensionManagement/common/extensionManagement.js';
import { isMalicious, getExtensionBlockedMessage } from '../../../../platform/extensionManagement/common/extensionManagementUtil.js';

interface Paths { root: string; builtin: string; profile: string; cache: string; targetPlatform: string }

/** Supplies the extension-management protocol over native downloads and a package helper. */
export function registerExtensionServices(server: IChannelServer<unknown>, host: Host): IDisposable {
	const disposables = new DisposableStore();
	const emitters = new Map<string, Emitter<unknown>>();
	let mutation: Promise<unknown> = Promise.resolve();
	const emitter = (name: string) => {
		let result = emitters.get(name);
		if (!result) { result = disposables.add(new Emitter<unknown>()); emitters.set(name, result); }
		return result;
	};
	const getPaths = () => host.call<Paths>('extensions.getPaths', {});
	const gallery = () => {
		const service = (globalThis as typeof globalThis & { __vscLightGallery?: IExtensionGalleryService }).__vscLightGallery;
		if (!service) { throw new Error('Marketplace is still initializing'); }
		return service;
	};
	const filePath = (value: unknown, profile = false) => {
		const uri = URI.revive(value as URI);
		if ((uri.scheme !== 'file' && !(profile && uri.scheme === 'vscode-userdata')) || uri.authority) { throw new Error('Only local extension package paths are supported'); }
		return uri.fsPath;
	};
	async function download(extension: IGalleryExtension): Promise<URI> {
		const paths = await getPaths();
		const target = URI.file(`${paths.cache}/${generateUuid()}.vsix`);
		const urls = [extension.assets.download.uri, extension.assets.download.fallbackUri].filter((url, index, all) => url && all.indexOf(url) === index);
		let failure: unknown;
		for (const url of urls) {
			try { await host.call('network.download', { url, path: target.fsPath, requestId: generateUuid(), timeout: 120000 }); return target; }
			catch (error) { failure = error; }
		}
		throw failure ?? new Error('Gallery extension has no download URL');
	}
	async function signature(extension: IGalleryExtension): Promise<{ path: string; publicKey: string }> {
		const product = (globalThis as typeof globalThis & { _VSCODE_PRODUCT_JSON?: { extensionsGallery?: { serviceUrl?: string } } })._VSCODE_PRODUCT_JSON;
		const service = product?.extensionsGallery?.serviceUrl;
		if (!service?.endsWith('/vscode/gallery')) { throw new Error('Signed packages require an Open VSX registry'); }
		const platform = extension.properties.targetPlatform;
		const target = platform && platform !== 'universal' && platform !== 'undefined' ? `${encodeURIComponent(platform)}/` : '';
		const url = `${service.slice(0, -'/vscode/gallery'.length)}/api/${encodeURIComponent(extension.publisher)}/${encodeURIComponent(extension.name)}/${target}${encodeURIComponent(extension.version)}`;
		async function text(url: string): Promise<string> {
			const response = await host.call<{ statusCode: number; body: Uint8Array }>('network.request', { url, requestId: generateUuid() });
			if (response.statusCode !== 200) { throw new Error(`Registry signing metadata returned HTTP ${response.statusCode}`); }
			return new TextDecoder().decode(response.body);
		}
		const metadata = JSON.parse(await text(url));
		if (metadata.namespace?.toLowerCase() !== extension.publisher.toLowerCase() || metadata.name?.toLowerCase() !== extension.name.toLowerCase() || metadata.version !== extension.version) { throw new Error('Registry signing metadata identity mismatch'); }
		if (!metadata.files?.signature || !metadata.files?.publicKey || new URL(metadata.files.publicKey).origin !== new URL(service).origin) { throw new Error('Registry signing key is missing or belongs to another origin'); }
		const publicKey = await text(metadata.files.publicKey);
		const path = `${(await getPaths()).cache}/${generateUuid()}.sigzip`;
		await host.call('network.download', { url: metadata.files.signature, path, requestId: generateUuid(), timeout: 120000 });
		return { path, publicKey };
	}
	async function install(source: IGalleryExtension | URI, options: InstallOptions = {}, ancestry = new Set<string>()): Promise<ILocalExtension> {
		const paths = await getPaths();
		const profileLocation = options.profileLocation ? URI.revive(options.profileLocation) : URI.file(paths.profile);
		const isGallery = !URI.isUri(source);
		const extension = isGallery ? source as IGalleryExtension : undefined;
		if (extension?.blockingInfo) { throw new Error(getExtensionBlockedMessage(extension.blockingInfo).value); }
		if (extension && !extension.allTargetPlatforms.some(target => isTargetPlatformCompatible(target, extension.allTargetPlatforms, paths.targetPlatform as import('../../../../platform/extensions/common/extensions.js').TargetPlatform))) { throw new Error('This extension is not available for the current platform'); }
		const packageUri = isGallery ? await download(extension!) : source as URI;
		let verification: { path: string; publicKey: string } | undefined;
		try {
			if (extension?.isSigned && !options.donotVerifySignature) { verification = await signature(extension); }
			const manifest = await host.call<{ publisher: string; name: string; extensionDependencies?: string[]; extensionPack?: string[] }>('extensions.getManifest', { path: packageUri.fsPath });
			const identifier = extension?.identifier ?? { id: `${manifest.publisher}.${manifest.name}`.toLowerCase() };
			const control = await gallery().getExtensionsControlManifest();
			if (isMalicious(identifier, control.malicious)) { throw new Error(`Extension is blocked by the marketplace: ${identifier.id}`); }
			const allowed = (globalThis as typeof globalThis & { __vscLightAllowedExtensions?: IAllowedExtensionsService }).__vscLightAllowedExtensions;
			const decision = allowed?.isAllowed(extension ?? { id: identifier.id, publisherDisplayName: undefined });
			if (decision && decision !== true) { throw new Error(decision.value); }
			if (ancestry.has(identifier.id.toLowerCase())) { throw new Error(`Cyclic extension dependency: ${identifier.id}`); }
			const lineage = new Set(ancestry).add(identifier.id.toLowerCase());
			if (!options.donotIncludePackAndDependencies) {
				const dependencies = [...new Set([...(manifest.extensionDependencies ?? []), ...(manifest.extensionPack ?? [])])];
				const installed = await host.call<ILocalExtension[]>('extensions.getInstalled', {});
				const missing = dependencies.filter(id => !installed.some(item => item.identifier.id.toLowerCase() === id.toLowerCase()));
				if (missing.length) {
					const { CancellationToken } = await import('../../../../base/common/cancellation.js');
					const targetPlatform = await call('getTargetPlatform', []) as import('../../../../platform/extensions/common/extensions.js').TargetPlatform;
					const resolved = await gallery().getExtensions(missing.map(id => ({ id })), { compatible: true, targetPlatform }, CancellationToken.None);
					for (const id of missing) {
						const dependency = resolved.find(item => item.identifier.id.toLowerCase() === id.toLowerCase());
						if (!dependency) { throw new Error(`Required extension is unavailable: ${id}`); }
						await install(dependency, options, lineage);
					}
				}
			}
			const event = { identifier, source, profileLocation, applicationScoped: options.isApplicationScoped };
			emitter('onInstallExtension').fire(event);
			try {
				const local = await host.call<ILocalExtension>('extensions.install', {
					signature: verification,
					path: packageUri.fsPath, profileLocation: profileLocation.fsPath,
					expectedId: extension?.identifier.id, expectedVersion: extension?.version,
					metadata: { id: extension?.identifier.uuid, publisherId: extension?.publisherId,
						publisherDisplayName: extension?.publisherDisplayName, targetPlatform: extension?.properties.targetPlatform,
						isPreReleaseVersion: extension?.properties.isPreReleaseVersion, hasPreReleaseVersion: extension?.hasPreReleaseVersion,
						isMachineScoped: options.isMachineScoped, isApplicationScoped: options.isApplicationScoped,
						preRelease: options.installPreReleaseVersion, pinned: options.pinned, source: isGallery ? 'gallery' : 'vsix' },
				});
				emitter('onDidInstallExtensions').fire([{ ...event, local, operation: InstallOperation.Install, context: options.context }]);
				return local;
			} catch (error) {
				emitter('onDidInstallExtensions').fire([{ ...event, operation: InstallOperation.Install, error: { name: 'Error', message: error instanceof Error ? error.message : String(error) } }]);
				throw error;
			}
		} finally {
			if (verification) { await host.call('fs.delete', { path: verification.path }).catch(() => {}); }
			if (isGallery) { await host.call('fs.delete', { path: packageUri.fsPath }).catch(() => {}); }
		}
	}
	async function call(command: string, args: unknown[]): Promise<unknown> {
		switch (command) {
			case 'getTargetPlatform': return (await getPaths()).targetPlatform;
			case 'getInstalled': return host.call('extensions.getInstalled', { type: args[0] ?? null, profileLocation: args[1] ? filePath(args[1], true) : undefined });
			case 'getManifest': return host.call('extensions.getManifest', { path: filePath(args[0]) });
			case 'install': return install(URI.revive(args[0] as URI), args[1] as InstallOptions);
			case 'installFromGallery': return install(args[0] as IGalleryExtension, args[1] as InstallOptions);
			case 'installGalleryExtensions': {
				const results = [];
				for (const entry of args[0] as { extension: IGalleryExtension; options: InstallOptions }[]) {
					const local = await install(entry.extension, entry.options);
					results.push({ identifier: local.identifier, source: entry.extension, local, operation: InstallOperation.Install, profileLocation: entry.options.profileLocation ?? URI.file((await getPaths()).profile) });
				}
				return results;
			}
			case 'download': return download(args[0] as IGalleryExtension);
			case 'uninstall': {
				const extension = args[0] as ILocalExtension;
				const options = (args[1] ?? {}) as { profileLocation?: URI };
				const profileLocation = options.profileLocation ? URI.revive(options.profileLocation) : URI.file((await getPaths()).profile);
				const event = { identifier: extension.identifier, profileLocation };
				emitter('onUninstallExtension').fire(event);
				try { await host.call('extensions.uninstall', { path: filePath(extension.location), options, profileLocation: profileLocation.fsPath }); emitter('onDidUninstallExtension').fire(event); }
				catch (error) { emitter('onDidUninstallExtension').fire({ ...event, error: String(error) }); throw error; }
				return;
			}
			case 'uninstallExtensions':
				for (const entry of args[0] as { extension: ILocalExtension; options: object }[]) { await call('uninstall', [entry.extension, entry.options]); } return;
			case 'updateMetadata': {
				const local = await host.call<ILocalExtension>('extensions.updateMetadata', { path: filePath((args[0] as ILocalExtension).location), metadata: args[1] });
				emitter('onDidUpdateExtensionMetadata').fire({ local, profileLocation: args[2] ?? URI.file((await getPaths()).profile) });
				return local;
			}
			case 'getExtensionsControlManifest': return gallery().getExtensionsControlManifest();
			case 'cleanUp': return;
			default: throw new Error(`Unsupported VSC-Light extension command: ${command}`);
		}
	}
	server.registerChannel('extensions', {
		listen: <T>(_context: unknown, name: string) => emitter(name).event as Event<T>,
		call: async <T>(_context: unknown, command: string, args: unknown[] = []) => {
			if (['install', 'installFromGallery', 'installGalleryExtensions', 'uninstall', 'uninstallExtensions', 'updateMetadata'].includes(command)) {
				const result = mutation.then(() => call(command, args));
				mutation = result.catch(() => {});
				return await result as T;
			}
			return await call(command, args) as T;
		},
	});
	server.registerChannel('extensionGalleryManifest', { listen: () => Event.None, call: async <T>() => undefined as T });
	server.registerChannel('request', { listen: () => Event.None, call: async <T>(_context: unknown, command: string, args: unknown[] = []) => {
		if (command === 'request') {
			const response = await host.call<{ statusCode: number; headers: object; body: Uint8Array }>('network.request', { ...(args[0] as object), requestId: generateUuid() });
			return [{ statusCode: response.statusCode, headers: response.headers }, VSBuffer.wrap(response.body)] as T;
		}
		if (command === 'loadCertificates') { return [] as T; }
		if (['resolveProxy', 'lookupAuthorization', 'lookupKerberosAuthorization'].includes(command)) { return undefined as T; }
		throw new Error(`Unsupported request command: ${command}`);
	} });
	server.registerChannel('download', { listen: () => Event.None, call: async <T>(_context: unknown, command: string, args: unknown[]) => {
		if (command !== 'download') { throw new Error(`Unsupported download command: ${command}`); }
		await host.call('network.download', { url: URI.revive(args[0] as URI).toString(), path: filePath(args[1]), requestId: generateUuid(), timeout: 120000 });
		return undefined as T;
	} });
	console.info('[vsc-light:ipc] registered channels extensions, extensionGalleryManifest, download');
	return disposables;
}
