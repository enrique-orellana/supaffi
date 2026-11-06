# Commerce event delivery

Commerce events are signed JSON `POST` requests. The same event keeps its ID
across delivery retries; receivers should use that ID to deduplicate requests.

```json
{
  "id": "evt_…",
  "data": {
    "provider": "nowpayments",
    "eventId": "…",
    "status": "finished",
    "sourceOrderId": "order-123",
    "paymentRef": "…",
    "checkoutRef": "…",
    "saleAmount": "49.00",
    "saleCurrency": "usd",
    "cryptoAmount": "0.0007",
    "cryptoCurrency": "btc",
    "cryptoNetwork": "btc",
    "occurredAt": "2026-11-06T12:00:00.000Z"
  }
}
```

Terminal payment events use `finished` or `refunded`. The amount fields are
decimal strings; crypto details can be `null` when the provider did not supply
them. Terminal event IDs include the source order, terminal status, and
provider payment reference, so a different payment for the same order has a
distinct identity.

## Invoice reference reconciliation

If two provider invoice references are reported for one order, delivery of
pending terminal events is held while the owner checks the provider's invoice
list. A terminal event already delivered is not removed or rewritten. The
outbox sends an `invoice_conflict` event to record that an external effect may
already have occurred. Its data includes the order and payment references and
the conflicting invoice references known to the system.

After the owner links the invoice they verified, `invoice_reconciled` records
the selected invoice reference. A held terminal event that has not been
delivered and never attempted is released with that reference. A request that
was processing, had a prior attempt, or had already been delivered is treated
as possibly accepted. Its original payload and event ID remain unchanged; it
is not replayed with a modified body. Instead, `invoice_reconciled` is queued
under a distinct event ID and carries the final `paymentStatus`, `paymentRef`,
sale amount/currency, and available crypto amount/currency/network. This gives
the receiver enough terminal payment information to reconcile even when the
original POST was not accepted.

If a verified refund is waiting to be applied, terminal success delivery and
commission release remain held. Once the refund is applied, the refund event
can be delivered and any possibly accepted earlier success is followed by an
`invoice_reconciled` correction whose `paymentStatus` is `refunded`.

Conflict and reconciliation event IDs are stable for an order, event kind,
reference set, payment reference, and terminal payment status. Receivers should deduplicate using
the event ID and the business key `sourceOrderId` (with `paymentRef` when
available), then apply payment statuses monotonically: `refunded` supersedes
`finished`, and a correction with the final status supersedes an earlier
conflict or terminal event for that order. Do not assume that arrival order
matches provider event order.
