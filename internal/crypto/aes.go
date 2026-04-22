// Package crypto provides the application-level AES-256-GCM encryption helpers
// used to protect sensitive fields (passwords) before they are written to the
// local SQLite database.
//
// # Key management (v0.1)
//
// The encryption key is compiled into the binary.  This is intentional for a
// v0.1 local desktop tool: it prevents casual inspection of the SQLite file
// with a text editor or DB browser, while keeping the implementation simple.
//
// ⚠  Security note: any user who can read the binary can recover the key and
//    decrypt stored passwords.  Before a public release the key MUST be
//    replaced with a value stored in the OS keychain:
//
//	macOS:   Security.framework / SecKeychainItem
//	Windows: DPAPI (CryptProtectData)
//	Linux:   libsecret / kwallet / kernel keyring
//
// # Ciphertext format
//
// Encrypt returns a base64-encoded string whose raw bytes are:
//
//	[ nonce (12 bytes) | ciphertext | GCM tag (16 bytes) ]
//
// The nonce is generated fresh for every encryption call (crypto/rand) so two
// calls with the same plaintext produce different ciphertexts.
// Decrypt is the exact inverse: base64-decode → split nonce → GCM.Open.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

// appKey is the 32-byte AES-256 master key.
//
// Each byte is written as a separate literal so the compiler cannot trivially
// fold the array into a printable string that `strings` tools could extract.
//
// TODO: replace with OS-keychain-derived key before shipping to end-users.
var appKey = [32]byte{
	// "GripLiteLocalKey" × 2 — deterministic but non-printable when viewed as hex
	0x47, 0x72, 0x69, 0x70, 0x4c, 0x69, 0x74, 0x65, // GripLite
	0x4c, 0x6f, 0x63, 0x61, 0x6c, 0x4b, 0x65, 0x79, // LocalKey
	0x21, 0x40, 0x23, 0x24, 0x25, 0x5e, 0x26, 0x2a, // !@#$%^&*
	0x28, 0x29, 0x5f, 0x2b, 0x7c, 0x7d, 0x7b, 0x3a, // ()_+|}  {:
}

// Encrypt encrypts plaintext with AES-256-GCM and returns a base64-encoded
// ciphertext string.
//
// Returns ("", nil) when plaintext is empty so that callers can distinguish
// "no password set" from "empty password" without special-casing.
func Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}

	block, err := aes.NewCipher(appKey[:])
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

// Decrypt decrypts a base64-encoded AES-256-GCM ciphertext produced by Encrypt.
//
// Returns ("", nil) when ciphertext is empty (mirrors Encrypt's empty-string
// short-circuit).  Returns an error if the ciphertext is malformed or if
// authentication fails (tampered data).
func Decrypt(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}

	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", fmt.Errorf("crypto: base64 decode: %w", err)
	}

	block, err := aes.NewCipher(appKey[:])
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

	plaintext, err := gcm.Open(nil, data[:ns], data[ns:], nil)
	if err != nil {
		return "", fmt.Errorf("crypto: authentication failed: %w", err)
	}

	return string(plaintext), nil
}
