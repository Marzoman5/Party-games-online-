/**
 * Funny, clean two-word default names for new players ("Wobbly Waffle"). Kept short (≤ 14 chars,
 * the session's name limit) and family-friendly. Players can rename themselves from the phone.
 */
const ADJ = [
  'Wobbly', 'Sneaky', 'Fuzzy', 'Jolly', 'Zippy', 'Bouncy', 'Sleepy', 'Spicy', 'Cosmic', 'Turbo', 'Mighty', 'Groovy',
  'Sassy', 'Lucky', 'Dizzy', 'Fancy', 'Crispy', 'Soggy', 'Brave', 'Shiny', 'Wiggly', 'Rowdy', 'Snappy', 'Chill',
  'Peppy', 'Funky', 'Cheeky', 'Speedy', 'Jumpy', 'Giddy',
];
const NOUN = [
  'Waffle', 'Noodle', 'Pickle', 'Muffin', 'Taco', 'Banana', 'Nugget', 'Pancake', 'Donut', 'Pretzel', 'Walrus',
  'Llama', 'Otter', 'Goose', 'Panda', 'Badger', 'Moose', 'Gecko', 'Toast', 'Dumpling', 'Biscuit', 'Turnip',
  'Potato', 'Mango', 'Penguin', 'Hamster', 'Yeti', 'Kiwi', 'Sprout', 'Bagel',
];

/** A random name not in `taken` (case-insensitive); falls back to a numbered one. */
export function funnyName(taken: Iterable<string>, rand: () => number = Math.random): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const a = ADJ[Math.floor(rand() * ADJ.length)];
    const n = NOUN[Math.floor(rand() * NOUN.length)];
    const name = `${a} ${n}`;
    if (name.length <= 14 && !used.has(name.toLowerCase())) return name;
  }
  for (let k = 2; ; k++) {
    const name = `${NOUN[Math.floor(rand() * NOUN.length)]} ${k}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}
