// The schema's migration in drizzle-kit's `durable-sqlite` shape, inlined: no `.sql` import rule.
const init = `CREATE TABLE todos (id text PRIMARY KEY, title text NOT NULL, done integer DEFAULT 0 NOT NULL);
--> statement-breakpoint
CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL);
--> statement-breakpoint
CREATE TABLE pairs (a text NOT NULL, b integer NOT NULL, label text NOT NULL, PRIMARY KEY (a, b));
--> statement-breakpoint
CREATE TABLE groups (id text PRIMARY KEY, name text NOT NULL);
--> statement-breakpoint
CREATE TABLE members (id text PRIMARY KEY, group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE, name text NOT NULL);`;

export default { migrations: { "0000_init": init } };
