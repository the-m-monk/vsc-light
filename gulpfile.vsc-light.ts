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
	)
)));