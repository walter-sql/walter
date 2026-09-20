-- Fixture for the differential test: a tiny chat domain with nested relations.
CREATE TABLE users (
  id     integer PRIMARY KEY,
  name   text NOT NULL,
  avatar text
);

CREATE TABLE rooms (
  id   integer PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE comments (
  id      integer PRIMARY KEY,
  room_id integer NOT NULL REFERENCES rooms(id),
  user_id integer NOT NULL REFERENCES users(id),
  body    text NOT NULL,
  score   integer NOT NULL DEFAULT 0,
  deleted boolean NOT NULL DEFAULT false
);

CREATE TABLE replies (
  id         integer PRIMARY KEY,
  comment_id integer NOT NULL REFERENCES comments(id),
  user_id    integer NOT NULL REFERENCES users(id),
  body       text NOT NULL
);

INSERT INTO users (id, name, avatar) VALUES
  (1, 'Ann', 'a.png'),
  (2, 'Bob', 'b.png'),
  (3, 'Cy',  'c.png');

INSERT INTO rooms (id, name) VALUES (1, 'general'), (2, 'random');

INSERT INTO comments (id, room_id, user_id, body, score) VALUES
  (1, 1, 1, 'hello world', 3),
  (2, 1, 2, 'hi Ann', 1),
  (3, 2, 3, 'off topic', 5);

INSERT INTO replies (id, comment_id, user_id, body) VALUES
  (1, 1, 2, 'hey!'),
  (2, 1, 3, 'welcome');
