type BankFeedQuickActionsProps = {
  isPlaidConnecting: boolean;
  onConnectPlaidLink: () => void;
  onConnectPlaidSandbox: () => void;
  onImportExpenseCatBusiness?: () => void;
  showImportExpenseCat?: boolean;
  onRefreshBankFeed: () => void | Promise<void>;
  showIncludePersonalToggle?: boolean;
  includePersonal: boolean;
  onToggleIncludePersonal: (checked: boolean) => void;
};

export function BankFeedQuickActions({
  isPlaidConnecting,
  onConnectPlaidLink,
  onConnectPlaidSandbox,
  onImportExpenseCatBusiness,
  showImportExpenseCat = false,
  onRefreshBankFeed,
  showIncludePersonalToggle = false,
  includePersonal,
  onToggleIncludePersonal,
}: BankFeedQuickActionsProps) {
  return (
    <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button onClick={onConnectPlaidLink} disabled={isPlaidConnecting}>
        {isPlaidConnecting ? "Opening Plaid..." : "Connect Bank (Plaid)"}
      </button>
      <button onClick={onConnectPlaidSandbox}>Connect Sandbox Bank</button>
      {showImportExpenseCat && onImportExpenseCatBusiness && (
        <button onClick={onImportExpenseCatBusiness}>Import Expense_CAT CSV (Business)</button>
      )}
      <button onClick={onRefreshBankFeed}>Refresh Bank Feed</button>
      {showIncludePersonalToggle && (
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12, color: "#4a6076" }}>
          <input
            type="checkbox"
            checked={includePersonal}
            onChange={(e) => onToggleIncludePersonal(e.target.checked)}
          />
          Include personal tx
        </label>
      )}
    </div>
  );
}
