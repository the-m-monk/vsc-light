/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalService, ITerminalGroupService } from '../browser/terminal.js';

/** Opt-in native integration probe: real workbench, terminal renderer, shell input and output. */
export async function verifyTerminal(instantiation: IInstantiationService): Promise<void> {
	const lifecycle = instantiation.invokeFunction(accessor => accessor.get(ILifecycleService));
	await lifecycle.when(LifecyclePhase.Restored);
	const terminals = instantiation.invokeFunction(accessor => accessor.get(ITerminalService));
	const groups = instantiation.invokeFunction(accessor => accessor.get(ITerminalGroupService));
	console.info('[vsc-light:verify] terminal creating');
	const terminal = await terminals.createTerminal({
		config: { executable: '/bin/sh', args: ['-i'], cwd: '/tmp', env: { PS1: '' }, isTransient: true },
		skipContributedProfileCheck: true,
	});
	terminals.setActiveInstance(terminal);
	await groups.showPanel(false);
	try {
		await terminal.processReady;
		console.info(`[vsc-light:verify] terminal ready pid=${terminal.processId}`);
		await new Promise<void>((resolve, reject) => {
			let output = '';
			const timer = setTimeout(() => { listener.dispose(); reject(new Error(`terminal output timed out: ${output}`)); }, 15000);
			const listener = terminal.onData(data => {
				output += data;
				if (output.includes('VSC_LIGHT_TERMINAL_OK')) { clearTimeout(timer); listener.dispose(); resolve(); }
			});
			terminal.sendText("test -t 0 && printf '%s%s\\n' VSC_LIGHT_ TERMINAL_OK", true).catch(reject);
		});
		console.info(`[vsc-light:verify] terminal succeeded pid=${terminal.processId} rendered=${!!terminal.domElement?.querySelector('.xterm')}`);
	} finally {
		terminal.dispose();
	}
}
