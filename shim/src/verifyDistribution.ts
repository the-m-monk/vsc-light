// Opt-in runtime evidence alongside the renderer-to-Rust filesystem probe.
export function verifyDistribution(): void {
  if (!window.location.search.includes('vsc-light-verify-filesystem')) return;
  let attempts = 0;
  const timer = window.setInterval(() => {
    const workbench = document.querySelector<HTMLElement>('.monaco-workbench');
    if (!workbench || workbench.clientHeight === 0) {
      if (++attempts >= 60) {
        window.clearInterval(timer);
        console.error('[vsc-light:verify] distribution workbench did not render');
      }
      return;
    }
    window.clearInterval(timer);
    const style = getComputedStyle(workbench);
    const watermark = document.querySelector('.editor-group-watermark .letterpress');
    console.info('[vsc-light:verify] distribution rendered', JSON.stringify({
      width: workbench.clientWidth,
      height: workbench.clientHeight,
      fontFamily: style.fontFamily,
      platformFont: style.getPropertyValue('--monaco-font').trim(),
      watermark: watermark ? getComputedStyle(watermark).backgroundImage : undefined,
    }));
    fetch('vsc-light://app/product.json').then(response => {
      if (!response.ok) throw new Error(`Product fetch failed: ${response.status}`);
      return response.json();
    }).then(product => console.info('[vsc-light:verify] distribution product', JSON.stringify({
      name: product.nameShort,
      gallery: product.extensionsGallery,
      telemetry: product.enableTelemetry,
      updateUrl: product.updateUrl ?? null,
    }))).catch(error => console.error('[vsc-light:verify] distribution product failed', error));
  }, 1000);
}
