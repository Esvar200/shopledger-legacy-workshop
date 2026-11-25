const assert = require('node:assert/strict');
const test = require('node:test');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

// Mirror the totals that POST /api/orders saves, using only in-memory items.
function billedOrder(items, coupon = '') {
  const { subtotal, discount, tax, total } = pricing.computeTotals(items, coupon);
  return { id: 1, status: 'completed', items, coupon, subtotal, discount, tax, total };
}

test('a mixed-rate coupon invoice matches the billed total and GST breakdown', () => {
  const order = billedOrder([
    { name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 600, qty: 1 }
  ], 'SAVE10');
  const { total, tax, cgst, sgst, discount, rows } = invoice.computeInvoiceFigures(order);

  assert.deepEqual({ total, tax, cgst, sgst, discount }, {
    total: 1560.56, tax: 110.56, cgst: 55.28, sgst: 55.28, discount: 150
  });
  assert.deepEqual(rows.map(row => [row.gstPercent, row.lineTax]), [[5, 45.31], [12, 65.25]]);
  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹110\.56/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹1560\.56/);
  assert.doesNotMatch(html, /Line GST is unavailable/);
});

test('invoice and checkout agree for a default-rate item without a coupon', () => {
  const order = billedOrder([{ name: 'Unclassified item', price: 100, qty: 1 }]);
  const { subtotal, discount, tax, cgst, sgst, total, rows } = invoice.computeInvoiceFigures(order);

  assert.deepEqual({ subtotal, discount, tax, cgst, sgst, total }, {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118
  });
  assert.equal(order.tax, 18);
  assert.equal(order.total, 118);
  assert.equal(rows[0].gstPercent, 18);
  assert.equal(rows[0].lineTax, 18);
  assert.doesNotMatch(invoice.render(order), /Line GST is unavailable/);
});

test('invoice and checkout allocate the extra GST paise to CGST', () => {
  const items = [{ name: 'Unclassified item', price: 10.05, qty: 1 }];
  const checkout = pricing.computeTotals(items, '');
  const figures = invoice.computeInvoiceFigures({ items });

  assert.deepEqual([checkout.tax, checkout.cgst, checkout.sgst, checkout.total],
    [1.81, 0.91, 0.90, 11.86]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total],
    [1.81, 0.91, 0.90, 11.86]);
});

test('checkout allocates a capped coupon across GST lines and the invoice reconciles', () => {
  const items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 600, qty: 1 }
  ];
  const order = billedOrder(items, 'SAVE10');
  const { lines, cgst, sgst } = pricing.computeTotals(items, order.coupon);

  assert.deepEqual(
    lines.map(({ gstPercent, discount, tax }) => ({ gstPercent, discount, tax })),
    [
      { gstPercent: 5, discount: 93.75, tax: 45.31 },
      { gstPercent: 12, discount: 56.25, tax: 65.25 }
    ]
  );
  assert.deepEqual([order.subtotal, order.discount, order.tax, cgst, sgst, order.total],
    [1600, 150, 110.56, 55.28, 55.28, 1560.56]);

  const report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.mismatchCount, 0);
  assert.equal(report.totalDelta, 0);
  assert.equal(report.rows[0].matched, true);
  assert.equal(report.rows[0].delta, 0);
});

test('a flat coupon reduces GST on both checkout and invoice', () => {
  const order = billedOrder([{ name: 'Unclassified item', price: 400, qty: 1 }], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 63, 413]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 63, 413]);
});

test('invoice handles whole-number, decimal, and zero GST rates like checkout', () => {
  const order = billedOrder([
    { name: 'Whole-number rate', price: 100, qty: 1, gstRate: 5 },
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 10);
  assert.deepEqual(figures.rows.map(row => [row.gstPercent, row.lineTax]), [[5, 5], [5, 5], [0, 0]]);
  assert.equal(figures.tax, 10);
  assert.equal(figures.total, 310);
});

test('invoice GST adds up to the displayed rounded line GST', () => {
  const order = billedOrder([
    { name: 'Small line A', price: 0.10, qty: 1, gstRate: 5 },
    { name: 'Small line B', price: 0.10, qty: 1, gstRate: 5 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.tax, order.total], [0.02, 0.22]);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.22]);
});

test('invoice preserves historical billed figures when line GST cannot be reconstructed', () => {
  const order = {
    id: 1, status: 'completed', subtotal: 100, discount: 0, tax: 12, total: 112,
    items: [{ name: 'Rice', hsn: '1006', price: 100, qty: 1 }]
  };
  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [12, 6, 6, 112]);
  assert.deepEqual([figures.rows[0].gstPercent, figures.rows[0].lineTax], [null, null]);
  const cancelled = { ...order, id: 2, status: 'cancelled' };
  const report = reports.getGstReconciliation({ orders: [order, cancelled] });

  assert.equal(report.totalChecked, 1);
  assert.equal(report.mismatchCount, 0);
  assert.equal(report.totalDelta, 0);
  const [row] = report.rows;
  assert.deepEqual(
    [row.orderId, row.ledgerTax, row.invoiceTax, row.delta, row.matched],
    [1, 12, 12, 0, true]
  );
  assert.match(invoice.render(order), /Line GST is unavailable for this order/);
});
