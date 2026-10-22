const NAMES = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Edsger Dijkstra', 'Barbara Liskov'];
const STATUS = ['pending', 'paid', 'shipped', 'delivered', 'returned'];
const CITIES: [string, number, number][] = [
  ['Paris', 48.85, 2.35],
  ['Tokyo', 35.68, 139.69],
  ['Lima', -12.05, -77.04],
  ['Oslo', 59.91, 10.75],
];

function order(id: number): string {
  const name = NAMES[id % NAMES.length]!;
  const [city, lat, lon] = CITIES[id % CITIES.length]!;
  let items = '';
  for (let i = 0; i < 1 + (id % 4); i++) {
    items += `<item sku="SKU-${(id * 7 + i) % 9973}" qty="${1 + ((id + i) % 5)}"><price>${(((id * 31 + i * 17) % 9000) / 100 + 1).toFixed(2)}</price></item>`;
  }
  const key = String(id).padStart(8, '0');
  return (
    `<order id="o-${key}" status="${STATUS[id % STATUS.length]}" currency="EUR">` +
    `<customer ref="c-${id % 50021}"><name>${name}</name><email>${name.split(' ')[0]!.toLowerCase()}@example.com</email></customer>` +
    `<geo:point city="${city}" lat="${lat}" lon="${lon}"/>` +
    `<items>${items}</items>` +
    (id % 3 === 0 ? '<note><![CDATA[Leave at <door> & ring twice]]></note>' : '') +
    (id % 5 === 0 ? '<memo>Priority <b>express</b> shipping</memo>' : '') +
    '</order>\n'
  );
}

/** A synthetic feed of roughly `megabytes` MiB, generated in slices to keep the page responsive. */
export async function sampleFile(megabytes: number): Promise<File> {
  const target = megabytes * 1024 * 1024;
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<!-- Generated in your browser by the xml-stream-format demo -->\n',
    '<feed xmlns="urn:example:feed" xmlns:geo="urn:example:geo">\n',
    '<meta><title>Synthetic order feed</title><generated>in-browser</generated></meta>\n',
  ];
  let size = 0;
  let id = 1;
  while (size < target) {
    let slice = '';
    while (slice.length < 1 << 20) slice += order(id++);
    parts.push(slice);
    size += slice.length;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  parts.push('</feed>\n');
  return new File(parts, `sample-${megabytes}mb.xml`, { type: 'application/xml' });
}
