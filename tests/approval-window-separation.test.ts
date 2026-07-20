import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('standalone approval window ownership', () => {
  it('keeps the Settings renderer free of pending approval UI and state', () => {
    const settingsApp = source('../src/renderer/panel/App.tsx');
    const panelPreload = source('../src/preload/panel.ts');

    expect(settingsApp).not.toContain('ComputerUseApprovalCard');
    expect(settingsApp).not.toContain('useComputerUseApproval');
    expect(panelPreload).not.toContain("subscribe('approval:requests'");
    expect(panelPreload).not.toContain("ipcRenderer.invoke('approval:resolve'");
  });

  it('builds and routes approvals through their own renderer, preload, and window manager', () => {
    const approvalApp = source('../src/renderer/approval/App.tsx');
    const approvalPreload = source('../src/preload/approval.ts');
    const buildConfig = source('../electron.vite.config.ts');
    const main = source('../src/main/index.ts');

    expect(approvalApp).toContain('ComputerUseApprovalCard');
    expect(approvalApp).not.toContain('buddy approval');
    expect(approvalApp).not.toContain('<Triangle');
    expect(approvalPreload).toContain("subscribe('approval:requests'");
    expect(approvalPreload).toContain("ipcRenderer.invoke('approval:resolve'");
    expect(buildConfig).toContain("approval: resolve(__dirname, 'src/preload/approval.ts')");
    expect(buildConfig).toContain(
      "approval: resolve(__dirname, 'src/renderer/approval/index.html')",
    );
    expect(main).toContain('const approvals = new ApprovalManager()');
    expect(main).toContain('approvals.update(requests)');
    expect(main).toContain("helperBuddy?.status === 'waiting_approval') approvals.show()");
    expect(main).toMatch(
      /await computerUseRuntime\.controller\.showApprovalWindow\([\s\S]*?approvals\.hide\(\)/,
    );
  });

  it('makes the yellow card the whole content-sized surface with attached actions', () => {
    const approvalApp = source('../src/renderer/approval/App.tsx');
    const approvalCard = source('../src/renderer/panel/components/ComputerUseApprovalCard.tsx');
    const approvalWindow = source('../src/main/windows/approval.ts');
    const approvalCss = source('../src/renderer/approval/approval.css');

    expect(approvalApp).toContain('clicky.setContentHeight(height)');
    expect(approvalCard).toContain('data-approval-surface');
    expect(approvalCard).toContain('data-approval-actions');
    expect(approvalCard).not.toContain('fixed right-4');
    expect(approvalWindow).toContain('transparent: true');
    expect(approvalWindow).toContain("backgroundColor: '#00000000'");
    expect(approvalWindow).not.toContain('applyMacLiquidGlass');
    expect(approvalCss).toContain('background: transparent !important');
  });
});
