CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    passwordSalt TEXT NOT NULL,
    lastIp TEXT NOT NULL,
    roles TEXT NOT NULL,
    lastToken TEXT,
    createdAt TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
