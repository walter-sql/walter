CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  starting_price numeric(12,2) NOT NULL CHECK (starting_price > 0),
  ends_at timestamptz NOT NULL,
  closed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES auctions(id),
  bidder_id uuid NOT NULL REFERENCES users(id),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON bids (auction_id);
CREATE INDEX ON bids (bidder_id);
CREATE INDEX ON auctions (closed, ends_at);

INSERT INTO users (name) VALUES
  ('Sedna'), ('Barents'), ('Beaufort'), ('Chukchi'), ('Laptev');

INSERT INTO auctions (seller_id, title, description, starting_price, ends_at) VALUES
  ((SELECT id FROM users WHERE name = 'Sedna'),
   'Brass diving helmet, 1962', 'Three-bolt Soviet pattern, glass intact.', 240, now() + interval '3 minutes'),
  ((SELECT id FROM users WHERE name = 'Barents'),
   'Ship''s chronometer', 'Two-day movement in a gimballed rosewood box.', 480, now() + interval '5 minutes'),
  ((SELECT id FROM users WHERE name = 'Beaufort'),
   'Scrimshaw chess set', 'Whalebone and ebony, one rook restored.', 320, now() + interval '7 minutes'),
  ((SELECT id FROM users WHERE name = 'Chukchi'),
   'Sextant in oak case', 'Vernier reads to ten arc-seconds.', 150, now() + interval '9 minutes'),
  ((SELECT id FROM users WHERE name = 'Laptev'),
   'First-edition Moby-Dick', 'London 1851, as The Whale, rebacked.', 900, now() + interval '12 minutes'),
  ((SELECT id FROM users WHERE name = 'Sedna'),
   'Icebreaker''s bell', 'Bronze, struck for the Yermak, 1898.', 410, now() + interval '15 minutes');
