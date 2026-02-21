"use client";

import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { API_BASE } from "../../../lib/api";

type PublicInvoicePaymentView = {
  invoice_number: string;
  client_name: string;
  issue_date: string;
  due_date: string;
  status: string;
  subtotal_amount: number;
  amount_paid: number;
  balance_due: number;
  notes: string;
  payment_link_expires_at: string | null;
  can_pay: boolean;
};

function formatCurrency(value: number): string {
  const abs = Math.abs(Number(value || 0));
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `($${formatted})` : `$${formatted}`;
}

export default function PublicPayPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token || "";
  const [invoice, setInvoice] = useState<PublicInvoicePaymentView | null>(null);
  const [amount, setAmount] = useState("");
  const [payerEmail, setPayerEmail] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/public/pay/${token}`, { cache: "no-store" });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const payload = JSON.parse(text) as PublicInvoicePaymentView;
      setInvoice(payload);
      if (!amount) setAmount(String(payload.balance_due || 0));
    } catch (err) {
      setMessage(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, [token]);

  async function submitPayment(e: FormEvent) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setMessage("Payment amount must be greater than 0.");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/public/pay/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: parsed, payer_email: payerEmail || null, note }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text}`);
      const payload = JSON.parse(text) as PublicInvoicePaymentView;
      setInvoice(payload);
      setMessage("Payment recorded successfully.");
    } catch (err) {
      setMessage(String(err));
    }
  }

  return (
    <main style={{ margin: "0 auto", maxWidth: 760, padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Invoice Payment</h1>
      {message && <p style={{ color: "#0a5" }}>{message}</p>}
      {!invoice && <p>Loading...</p>}
      {invoice && (
        <section style={{ border: "1px solid #ddd", padding: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{invoice.invoice_number}</div>
          <div style={{ color: "#4a4a4a" }}>{invoice.client_name}</div>
          <div style={{ marginTop: 8 }}>
            Amount Due: <strong>{formatCurrency(invoice.balance_due)}</strong>
          </div>
          <div>
            Total: {formatCurrency(invoice.subtotal_amount)} | Paid: {formatCurrency(invoice.amount_paid)} | Status: {invoice.status}
          </div>
          {invoice.payment_link_expires_at && <div>Link Expires: {invoice.payment_link_expires_at}</div>}
          {invoice.notes && <div style={{ marginTop: 8 }}>Notes: {invoice.notes}</div>}

          {invoice.can_pay ? (
            <form onSubmit={submitPayment} style={{ marginTop: 12, display: "grid", gap: 8 }}>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Payment amount" />
              <input value={payerEmail} onChange={(e) => setPayerEmail(e.target.value)} placeholder="Your email (optional)" />
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Payment note (optional)" />
              <button type="submit">Submit Payment</button>
            </form>
          ) : (
            <p style={{ marginTop: 12, color: "#b00020" }}>This payment link is not currently valid.</p>
          )}
        </section>
      )}
    </main>
  );
}
