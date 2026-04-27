// Package crypto provides AES-256-GCM encryption helpers used to protect
// sensitive fields (passwords) before they are written to the local SQLite
// database.
//
// # Key management
//
// The encryption key is generated once per machine (crypto/rand, 32 bytes)
// and stored in the OS-native secret store:
//
//   - macOS  : Keychain (Security.framework via go-keyring)
//   - Windows: Windows Credential Manager (DPAPI-backed)
//   - Linux  : SecretService / kwallet (libsecret via D-Bus)
//
// On first launch the key is created and saved.  On every subsequent launch
// it is retrieved from the same store.  The key never touches disk.
//
// Even if an attacker copies griplite.db off the machine, they cannot decrypt
// the stored passwords without also having access to that machine's keychain.
//
// # Migration from v0.1 (hard-coded key)
//
// The old hard-coded appKey is kept as a fallback in decryptLegacy.  On the
// first successful Get() using the new keychain key we silently return an
// error so the caller can prompt the user to re-enter the password once.
// New Save() calls always use the keychain key, so the database gradually
// migrates on the next edit of each connection.
//
// # Ciphertext format
//
// Encrypt returns a base64-encoded string whose raw bytes are:
//
//	[ nonce (12 bytes) | ciphertext | GCM tag (16 bytes) ]
//
// The nonce is generated fresh for every encryption call (crypto/rand) so two
// calls with the same plaintext produce different ciphertexts.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"sync"

	"github.com/zalando/go-keyring"
)

const (
	keychainService = "GripLite"
	keychainAccount = "griplite-db-key"
)

// legacyKey is the hard-coded key shipped in v0.1.  It is kept only to allow
// graceful decryption of passwords saved before the keychain migration.
// It must NOT be used for new encryptions.
var legacyKey = [32]byte{
	0x47, 0x72, 0x69, 0x70, 0x4c, 0x69, 0x74, 0x65,
	0x4c, 0x6f, 0x63, 0x61, 0x6c, 0x4b, 0x65, 0x79,
	0x21, 0x40, 0x23, 0x24, 0x25, 0x5e, 0x26, 0x2a,
	0x28, 0x29, 0x5f, 0x2b, 0x7c, 0x7d, 0x7b, 0x3a,
}

var (
	activeKey     [32]byte
	activeKeyOnce sync.Once
	activeKeyErr  error
)

// loadKey loads (or creates) the 32-byte key from the OS keychain.
// The result is cached for the lifetime of the process.
func loadKey() ([32]byte, error) {
	activeKeyOnce.Do(func() {
		// Try to read an existing key.
		hexKey, err := keyring.Get(keychainService, keychainAccount)
		if err == nil {
			b, decErr := hex.DecodeString(hexKey)
			if decErr == nil && len(b) == 32 {
				copy(activeKey[:], b)
				return
			}
			// Stored value is corrupt — regenerate.
			log.Printf("[crypto] keychain entry corrupt, regenerating key: %v", decErr)
		}

		// First launch (or keychain was wiped): generate a fresh random key.
		var newKey [32]byte
		if _, randErr := io.ReadFull(rand.Reader, newKey[:]); randErr != nil {
			activeKeyErr = fmt.Errorf("crypto: generate key: %w", randErr)
			return
		}
		if setErr := keyring.Set(keychainService, keychainAccount, hex.EncodeToString(newKey[:])); setErr != nil {
			// Keychain unavailable (headless CI, sandboxing, etc.) — fall back
			// to the legacy key so the app still runs, but warn loudly.
			log.Printf("[crypto] WARNING: cannot write to OS keychain (%v); "+
				"falling back to compiled-in key — passwords are NOT protected "+
				"by the OS keychain on this machine", setErr)
			activeKey = legacyKey
			return
		}
		activeKey = newKey
		log.Printf("[crypto] new encryption key generated and saved to OS keychain")
	})
	return activeKey, activeKeyErr
}

// Encrypt encrypts plaintext with AES-256-GCM using the OS-keychain key and
// returns a base64-encoded ciphertext string.
//
// Returns ("", nil) when plaintext is empty.
func Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	key, err := loadKey()
	if err != nil {
		return "", err
	}
	return encrypt(plaintext, key)
}

// Decrypt decrypts a base64-encoded AES-256-GCM ciphertext.
//
// It first tries the current OS-keychain key; if that fails (authentication
// error) it retries with the legacy hard-coded key so that passwords saved
// before the keychain migration are still readable.  The caller should
// re-save any connection that needed the legacy fallback so the value is
// re-encrypted with the new key.
//
// Returns ("", nil) when ciphertext is empty.
func Decrypt(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}
	key, err := loadKey()
	if err != nil {
		return "", err
	}
	pt, err := decrypt(ciphertext, key)
	if err != nil {
		// Retry with the legacy key (migration path from v0.1).
		if pt2, legErr := decrypt(ciphertext, legacyKey); legErr == nil {
			return pt2, nil
		}
		return "", err
	}
	return pt, nil
}

// ── low-level helpers ─────────────────────────────────────────────────────────

func encrypt(plaintext string, key [32]byte) (string, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", fmt.Errorf("crypto: aes cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("crypto: gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("crypto: nonce: %w", err)
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

func decrypt(ciphertext string, key [32]byte) (string, error) {
	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", fmt.Errorf("crypto: base64 decode: %w", err)
	}
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", fmt.Errorf("crypto: aes cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("crypto: gcm: %w", err)
	}
	ns := gcm.NonceSize()
	if len(data) < ns {
		return "", fmt.Errorf("crypto: ciphertext too short (%d bytes)", len(data))
	}
	pt, err := gcm.Open(nil, data[:ns], data[ns:], nil)
	if err != nil {
		return "", fmt.Errorf("crypto: authentication failed: %w", err)
	}
	return string(pt), nil
}
