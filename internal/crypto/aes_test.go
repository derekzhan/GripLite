package crypto

import (
	"strings"
	"testing"
)

func TestEncryptDecryptRoundtrip(t *testing.T) {
	cases := []string{
		"hunter2",
		"p@ssw0rd!#$%",
		"very long password that exceeds typical lengths for thorough coverage",
		"",
	}

	for _, plain := range cases {
		enc, err := Encrypt(plain)
		if err != nil {
			t.Fatalf("Encrypt(%q): %v", plain, err)
		}

		got, err := Decrypt(enc)
		if err != nil {
			t.Fatalf("Decrypt of Encrypt(%q): %v", plain, err)
		}

		if got != plain {
			t.Errorf("roundtrip mismatch: want %q, got %q", plain, got)
		}
	}
}

func TestEncryptNonce(t *testing.T) {
	// Two encryptions of the same value must produce different ciphertexts (random nonce).
	a, _ := Encrypt("secret")
	b, _ := Encrypt("secret")
	if a == b {
		t.Error("expected different ciphertexts for same plaintext (nonce must be random)")
	}
}

func TestDecryptTampered(t *testing.T) {
	enc, _ := Encrypt("hello")
	// Flip a byte in the middle of the base64 string.
	tampered := []byte(enc)
	tampered[len(tampered)/2] ^= 0xFF
	_, err := Decrypt(string(tampered))
	if err == nil {
		t.Error("expected error for tampered ciphertext, got nil")
	}
}

func TestEncryptNotPlaintext(t *testing.T) {
	enc, _ := Encrypt("secret")
	if strings.Contains(enc, "secret") {
		t.Error("ciphertext must not contain the plaintext")
	}
}
