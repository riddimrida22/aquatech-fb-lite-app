export const metadata = {
  title: "Privacy Policy — AquatechPM",
  description:
    "Privacy policy for AquatechPM, the internal project-controls and accounting application of Aquatech Engineering P.C.",
};

export default function PrivacyPage() {
  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: "48px 32px",
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        lineHeight: 1.55,
        color: "#15263d",
      }}
    >
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>Privacy Policy</h1>
      <p style={{ color: "#5c6b7c", marginTop: 0 }}>
        AquatechPM &middot; effective 2026-05-06
      </p>

      <section>
        <h2>Who we are</h2>
        <p>
          AquatechPM is the internal project-controls and accounting application
          of <strong>Aquatech Engineering P.C.</strong>, a New York-licensed
          professional engineering corporation. The application is operated for
          our own staff and authorized contractors only and is not offered as a
          commercial product to third parties.
        </p>
      </section>

      <section>
        <h2>What data we collect</h2>
        <ul>
          <li>
            <strong>Staff identity</strong> — name, work email address, role,
            employment start date. Authenticated via Google Workspace OAuth on
            our company domain.
          </li>
          <li>
            <strong>Time entries</strong> — hours, project, task, and notes
            recorded by staff for engineering work.
          </li>
          <li>
            <strong>Project + financial records</strong> — clients, invoices,
            expenses, payments, project budgets imported from internal systems.
          </li>
          <li>
            <strong>Bank transactions</strong> — read-only feed from the firm&rsquo;s
            business banking accounts via Plaid (or CSV exports), used for
            reconciliation against invoices and expenses.
          </li>
          <li>
            <strong>Payroll records</strong> — employer cost, employer payroll
            taxes, employer 401(k) match, gross wages, hours paid, net pay,
            sourced from Gusto via API or Payroll Journal Report CSV. Used for
            cost-of-goods-sold attribution against project budgets.
          </li>
          <li>
            <strong>FreshBooks records</strong> — clients, invoices, expenses,
            payments imported to maintain historical accounting continuity
            during our transition off FreshBooks.
          </li>
        </ul>
      </section>

      <section>
        <h2>How we use the data</h2>
        <p>
          The data is used solely for internal project management, financial
          reporting, payroll-cost attribution, and cash-flow forecasting at
          Aquatech Engineering P.C. We do not sell, license, or share this
          information with third parties for marketing or analytics.
        </p>
      </section>

      <section>
        <h2>Third-party integrations</h2>
        <p>
          AquatechPM connects to the following services on behalf of authorized
          firm administrators using OAuth or read-only API tokens:
        </p>
        <ul>
          <li>
            <strong>Gusto</strong> — read-only access to company, employees, and
            payroll runs. We do not run or modify payroll through this
            integration.
          </li>
          <li>
            <strong>FreshBooks</strong> — read-only access to clients, invoices,
            expenses, payments, and time entries.
          </li>
          <li>
            <strong>Plaid</strong> — read-only access to business bank account
            balances and transactions.
          </li>
          <li>
            <strong>Google Workspace</strong> — sign-in via OAuth, restricted
            to the firm&rsquo;s company domain.
          </li>
        </ul>
        <p>
          Tokens for these integrations are stored encrypted at rest in the
          application database and are accessible only by authenticated
          administrators of the application.
        </p>
      </section>

      <section>
        <h2>Where the data lives</h2>
        <p>
          Data is stored on infrastructure controlled by Aquatech Engineering
          P.C. Backups are encrypted at rest and retained according to our
          internal records retention schedule.
        </p>
      </section>

      <section>
        <h2>Access</h2>
        <p>
          Access to the application is limited to current employees and
          authorized contractors of Aquatech Engineering P.C., enforced through
          Google Workspace domain restriction and role-based permissions.
        </p>
      </section>

      <section>
        <h2>Retention</h2>
        <p>
          Time, financial, and payroll records are retained as required by
          applicable accounting and tax recordkeeping rules (typically seven
          years). Bank-transaction feeds are retained for reconciliation
          history. Integration tokens are deleted on user disconnect or when
          the integrating service marks the token as revoked.
        </p>
      </section>

      <section>
        <h2>Data subject rights</h2>
        <p>
          Current and former employees may request a copy of their personal
          time and payroll records, or correction of inaccurate records, by
          contacting the firm administrator. Records subject to legal or
          regulatory retention requirements will be retained for the minimum
          required period before deletion.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about this policy or the data handled by AquatechPM should
          be directed to:
        </p>
        <p>
          Bertrand Byrne, Principal
          <br />
          Aquatech Engineering P.C.
          <br />
          Email: <a href="mailto:bertrand.byrne@aquatechpc.com">bertrand.byrne@aquatechpc.com</a>
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>
          This policy may be updated as integrations or data sources change.
          The effective date at the top of this document reflects the current
          version.
        </p>
      </section>
    </main>
  );
}
