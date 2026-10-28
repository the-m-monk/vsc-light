import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as task from './lib/gulp/task.ts';
import { runEsbuildBundle } from './lib/esbuild.ts';
import { copyCodiconsTask } from './lib/compilation.ts';

task.task(task.define('vsc-light-bundle', task.series(
	copyCodiconsTask,

	task.define('vsc-light-esbuild', () =>
		runEsbuildBundle(
			'out-vscode',
			false,       // no minification
			true,        // NLS
			'desktop',
			undefined
		)
	),
	task.define('vsc-light-extension-host', async () => {
		await esbuild.build({
			absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
			entryPoints: ['src/vs/platform/extensions/vsc-light/extensionHostHelper.ts'],
			bundle: true, platform: 'node', format: 'esm',
			outfile: 'out-vscode/vsc-light-extension-host.mjs',
		});
	})
)));
