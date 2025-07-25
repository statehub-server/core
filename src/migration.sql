CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    passwordSalt TEXT NOT NULL,
    lastIp TEXT NOT NULL,
    lastToken TEXT,
    createdAt TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS userPermissions(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    userId UUID NOT NULL,
    permission TEXT NOT NULL,
    minrole TEXT NOT NULL,
    createdAt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fkuser
        FOREIGN KEY(userId)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oauthIdentities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  userId UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  providerId TEXT NOT NULL,
  createdAt TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider, providerId)
);

INSERT INTO users(
    username,
    email,
    passwordHash,
    passwordSalt,
    lastIp
) VAlUES (
    'admin',
    '',
    'ff919038ba8e6fec9ef9dbd4e60b7d7721230ad651ee589e94598bad1916fb29f288d202fe01b2447ed8b635b9e69237e2c50460ce9bcad7bb4cca0a675bc3af',
    'ZNjbdEu5HjUQhnEUNQxPXSR/1mX8vBWluAAYzFOWxhK87xTxVu3XHPGDOlBzu4IQgb9+WoiWhf+/ITM64Toq0A==',
    '127.0.0.1'
) ON CONFLICT(username) DO NOTHING;

WITH admin_user AS (
    SELECT id
    FROM users
    WHERE username = 'admin'
    LIMIT 1
)
INSERT INTO userPermissions (userId, permission, minrole)
SELECT admin_user.id, 'superuser', '' 
FROM admin_user
WHERE NOT EXISTS (
    SELECT 1
    FROM userPermissions
    WHERE userId = admin_user.id
    AND permission = 'superuser'
);
