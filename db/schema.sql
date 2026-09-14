BEGIN;

DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders      CASCADE;
DROP TABLE IF EXISTS products    CASCADE;
DROP TABLE IF EXISTS categories  CASCADE;
DROP TABLE IF EXISTS users       CASCADE;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text        NOT NULL,
    full_name  text        NOT NULL,
    role       text        NOT NULL DEFAULT 'buyer',
    is_active  boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_email_uniq   UNIQUE (email),
    CONSTRAINT users_email_chk    CHECK (position('@' in email) > 1),
    CONSTRAINT users_role_chk     CHECK (role IN ('buyer', 'seller', 'admin'))
);

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug  text NOT NULL,
    title text NOT NULL,

    CONSTRAINT categories_slug_uniq UNIQUE (slug)
);

-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
CREATE TABLE products (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    seller_id   bigint        NOT NULL,
    category_id bigint,
    name        text          NOT NULL,
    description text          NOT NULL DEFAULT '',
    price       numeric(12,2) NOT NULL,
    stock       integer       NOT NULL DEFAULT 0,
    is_active   boolean       NOT NULL DEFAULT true,
    created_at  timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT products_seller_fk   FOREIGN KEY (seller_id)   REFERENCES users(id)      ON DELETE RESTRICT,
    CONSTRAINT products_category_fk FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
    CONSTRAINT products_name_chk    CHECK (length(btrim(name)) > 0),
    CONSTRAINT products_price_chk   CHECK (price > 0),
    CONSTRAINT products_stock_chk   CHECK (stock >= 0)
);

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint        NOT NULL,
    status       text          NOT NULL DEFAULT 'pending',
    total_amount numeric(12,2) NOT NULL DEFAULT 0,
    created_at   timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT orders_user_fk   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT orders_status_chk CHECK (status IN ('pending','paid','shipped','delivered','cancelled')),
    CONSTRAINT orders_total_chk  CHECK (total_amount >= 0)
);

-- ---------------------------------------------------------------------------
-- order_items
-- ---------------------------------------------------------------------------
CREATE TABLE order_items (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id   bigint        NOT NULL,
    product_id bigint        NOT NULL,
    quantity   integer       NOT NULL,
    unit_price numeric(12,2) NOT NULL,

    CONSTRAINT order_items_order_fk   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
    CONSTRAINT order_items_uniq       UNIQUE (order_id, product_id),
    CONSTRAINT order_items_qty_chk    CHECK (quantity > 0),
    CONSTRAINT order_items_price_chk  CHECK (unit_price > 0)
);


DO $grant$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
		GRANT ALL ON ALL TABLES IN SCHEMA public TO app_user;
		GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO app_user;
	END IF;
END
$grant$;

COMMIT;