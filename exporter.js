// exporter.js
// Convert parsed data into a JSON string optimized for LLM consumption.

export function toCopyJson(data, options = {}) {
  const includeExtras = options.includeExtras !== false;

  const output = {
    trip: data.trip,
    exported_at: new Date().toISOString(),
    days: data.days.map(d => ({
      list_name: d.list_name,
      date: d.date,
      items: d.items,
    })),
  };

  if (includeExtras && data.extras && Object.keys(data.extras).length > 0) {
    output.extras = data.extras;
  }

  return JSON.stringify(output, null, 2);
}
