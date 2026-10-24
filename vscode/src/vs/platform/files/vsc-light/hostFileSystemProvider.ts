/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../base/common/buffer.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { canceled } from '../../../base/common/errors.js';
import { Event } from '../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../base/common/lifecycle.js';
import { newWriteableStream, ReadableStreamEvents } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { IDiskFileSystemProvider } from '../common/diskFileSystemProviderServer.js';
import { createFileSystemProviderError, FilePermission, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileAtomicReadOptions, IFileChange, IFileDeleteOptions, IFileOpenOptions, IFileOverwriteOptions, IFileReadStreamOptions, IFileWriteOptions, IStat, IWatchOptions } from '../common/files.js';

/** The generic capability bridge installed by VSC-Light's preload. */
export interface Host {
	call<T>(method: string, args: object): Promise<T>;
}

interface NativeEntry {
	kind: 'file' | 'directory' | 'unknown';
	symbolicLink: boolean;
}

interface NativeStat extends NativeEntry {
	ctime: number;
	mtime: number;
	size: number;
	readonly: boolean;
	executable: boolean;
}

function fileType(entry: NativeEntry): FileType {
	return (entry.kind === 'file' ? FileType.File : entry.kind === 'directory' ? FileType.Directory : FileType.Unknown) |
		(entry.symbolicLink ? FileType.SymbolicLink : 0);
}

const nativeErrorCodes: Record<string, FileSystemProviderErrorCode> = {
	ENOENT: FileSystemProviderErrorCode.FileNotFound,
	EEXIST: FileSystemProviderErrorCode.FileExists,
	ENOTDIR: FileSystemProviderErrorCode.FileNotADirectory,
	EISDIR: FileSystemProviderErrorCode.FileIsADirectory,
	EACCES: FileSystemProviderErrorCode.NoPermissions,
	EPERM: FileSystemProviderErrorCode.NoPermissions,
	ENOSYS: FileSystemProviderErrorCode.Unavailable,
	EBADF: FileSystemProviderErrorCode.Unavailable,
};

/** Adapts generic native filesystem calls to VS Code's provider contract. */
export class HostFileSystemProvider extends Disposable implements IDiskFileSystemProvider {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite |
		FileSystemProviderCapabilities.FileReadStream |
		FileSystemProviderCapabilities.FileAtomicRead |
		FileSystemProviderCapabilities.FileRealpath |
		FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	readonly onDidChangeFile: Event<readonly IFileChange[]> = Event.None;

	constructor(private readonly host: Host) {
		super();
		console.info('[vsc-light:fs] provider initialized');
	}

	private path(resource: URI): string {
		if (resource.scheme !== 'file' || resource.authority) {
			throw createFileSystemProviderError(`Unsupported local resource: ${resource}`, FileSystemProviderErrorCode.Unavailable);
		}
		return resource.fsPath;
	}

	private async call<T>(method: string, args: object): Promise<T> {
		try {
			return await this.host.call<T>(method, args);
		} catch (error) {
			const native = error as Error & { code?: string };
			throw createFileSystemProviderError(native.message, nativeErrorCodes[native.code ?? ''] ?? FileSystemProviderErrorCode.Unknown);
		}
	}

	async stat(resource: URI): Promise<IStat> {
		const stat = await this.call<NativeStat>('fs.stat', { path: this.path(resource) });
		return {
			type: fileType(stat), ctime: stat.ctime, mtime: stat.mtime, size: stat.size,
			permissions: (stat.readonly ? FilePermission.Locked : 0) | (stat.executable ? FilePermission.Executable : 0),
		};
	}

	realpath(resource: URI): Promise<string> {
		return this.call('fs.realpath', { path: this.path(resource) });
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		const entries = await this.call<(NativeEntry & { name: string })[]>('fs.readDir', { path: this.path(resource) });
		return entries.map(entry => [entry.name, fileType(entry)]);
	}

	readFile(resource: URI, _opts?: IFileAtomicReadOptions): Promise<Uint8Array> {
		return this.call('fs.readFile', { path: this.path(resource) });
	}

	readFileStream(resource: URI, opts: IFileReadStreamOptions, token: CancellationToken): ReadableStreamEvents<Uint8Array> {
		const stream = newWriteableStream<Uint8Array>(chunks => VSBuffer.concat(chunks.map(chunk => VSBuffer.wrap(chunk))).buffer);
		(async () => {
			try {
				if (token.isCancellationRequested) { throw canceled(); }
				if (typeof opts.limits?.size === 'number' && (await this.stat(resource)).size > opts.limits.size) {
					throw createFileSystemProviderError('File exceeds read size limit', FileSystemProviderErrorCode.FileTooLarge);
				}
				let contents = await this.readFile(resource);
				if (token.isCancellationRequested) { throw canceled(); }
				contents = contents.subarray(opts.position ?? 0);
				if (typeof opts.length === 'number') { contents = contents.subarray(0, opts.length); }
				stream.end(contents);
			} catch (error) {
				stream.error(error);
				stream.end();
			}
		})();
		return stream;
	}

	writeFile(resource: URI, contents: Uint8Array, opts: IFileWriteOptions): Promise<void> {
		return this.call('fs.writeFile', { path: this.path(resource), contents, ...opts });
	}

	mkdir(resource: URI): Promise<void> {
		return this.call('fs.mkdir', { path: this.path(resource) });
	}

	rename(from: URI, to: URI, opts: IFileOverwriteOptions): Promise<void> {
		return this.call('fs.rename', { path: this.path(from), to: this.path(to), ...opts });
	}

	delete(resource: URI, opts: IFileDeleteOptions): Promise<void> {
		return this.call('fs.delete', { path: this.path(resource), ...opts });
	}

	private unsupported(operation: string): never {
		throw createFileSystemProviderError(`Native ${operation} is not supported by VSC-Light yet`, FileSystemProviderErrorCode.Unavailable);
	}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable { return this.unsupported('watch'); }
	async open(_resource: URI, _opts: IFileOpenOptions): Promise<number> { return this.unsupported('open'); }
	async close(_fd: number): Promise<void> { return this.unsupported('close'); }
	async read(_fd: number, _pos: number, _data: Uint8Array, _offset: number, _length: number): Promise<number> { return this.unsupported('read'); }
	async write(_fd: number, _pos: number, _data: Uint8Array, _offset: number, _length: number): Promise<number> { return this.unsupported('write'); }
	async copy(_from: URI, _to: URI, _opts: IFileOverwriteOptions): Promise<void> { return this.unsupported('copy'); }
	async cloneFile(_from: URI, _to: URI): Promise<void> { return this.unsupported('cloneFile'); }
}
