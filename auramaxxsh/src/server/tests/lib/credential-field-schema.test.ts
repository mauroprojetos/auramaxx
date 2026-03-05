import { describe, it, expect } from 'vitest';
import {
  getCredentialFieldSpec,
  CREDENTIAL_FIELD_SCHEMA,
  type CredentialFieldSpec,
  type CredentialType,
} from '../../../../shared/credential-field-schema';

// ---------------------------------------------------------------------------
// getCredentialFieldSpec
// ---------------------------------------------------------------------------

describe('getCredentialFieldSpec', () => {
  describe('known type + key lookups', () => {
    it('returns spec for login/username (non-sensitive)', () => {
      const spec = getCredentialFieldSpec('login', 'username');
      expect(spec).toBeDefined();
      expect(spec!.key).toBe('username');
      expect(spec!.sensitive).toBe(false);
      expect(spec!.label).toBe('Username');
    });

    it('returns spec for login/password (sensitive)', () => {
      const spec = getCredentialFieldSpec('login', 'password');
      expect(spec).toBeDefined();
      expect(spec!.key).toBe('password');
      expect(spec!.sensitive).toBe(true);
      expect(spec!.type).toBe('secret');
    });

    it('returns spec for card/cardholder (non-sensitive)', () => {
      const spec = getCredentialFieldSpec('card', 'cardholder');
      expect(spec).toBeDefined();
      expect(spec!.sensitive).toBe(false);
    });

    it('returns spec for card/cvv (sensitive)', () => {
      const spec = getCredentialFieldSpec('card', 'cvv');
      expect(spec).toBeDefined();
      expect(spec!.sensitive).toBe(true);
      expect(spec!.type).toBe('secret');
    });

    it('returns spec for hot_wallet/private_key (sensitive)', () => {
      const spec = getCredentialFieldSpec('hot_wallet', 'private_key');
      expect(spec).toBeDefined();
      expect(spec!.sensitive).toBe(true);
    });

    it('returns spec for hot_wallet/address (non-sensitive)', () => {
      const spec = getCredentialFieldSpec('hot_wallet', 'address');
      expect(spec).toBeDefined();
      expect(spec!.sensitive).toBe(false);
    });

    it('returns spec for ssh/fingerprint (non-sensitive)', () => {
      const spec = getCredentialFieldSpec('ssh', 'fingerprint');
      expect(spec).toBeDefined();
      expect(spec!.sensitive).toBe(false);
    });

    it('returns spec for ssh/private_key (sensitive)', () => {
      const spec = getCredentialFieldSpec('ssh', 'private_key');
      expect(spec).toBeDefined();
      expect(spec!.sensitive).toBe(true);
    });

    it('returns spec for oauth2/access_token (sensitive)', () => {
      const spec = getCredentialFieldSpec('oauth2', 'access_token');
      expect(spec).toBeDefined();
      expect(spec!.sensitive).toBe(true);
    });

    it('returns spec for oauth2/token_endpoint (non-sensitive)', () => {
      const spec = getCredentialFieldSpec('oauth2', 'token_endpoint');
      expect(spec).toBeDefined();
      expect(spec!.sensitive).toBe(false);
      expect(spec!.type).toBe('url');
    });
  });

  describe('unknown type or key', () => {
    it('returns undefined for unknown credential type', () => {
      expect(getCredentialFieldSpec('nonexistent', 'password')).toBeUndefined();
    });

    it('returns undefined for unknown field key on valid type', () => {
      expect(getCredentialFieldSpec('login', 'nonexistent_field')).toBeUndefined();
    });

    it('returns undefined for empty type', () => {
      expect(getCredentialFieldSpec('', 'password')).toBeUndefined();
    });

    it('returns undefined for empty key on valid type', () => {
      // canonicalizeCredentialFieldKey trims empty to '', which won't match any spec
      expect(getCredentialFieldSpec('login', '')).toBeUndefined();
    });
  });

  describe('alias resolution', () => {
    it('resolves login/otp alias to totp spec', () => {
      const spec = getCredentialFieldSpec('login', 'otp');
      expect(spec).toBeDefined();
      expect(spec!.key).toBe('totp');
      expect(spec!.sensitive).toBe(true);
    });

    it('resolves note/value alias to content spec', () => {
      const spec = getCredentialFieldSpec('note', 'value');
      expect(spec).toBeDefined();
      expect(spec!.key).toBe('content');
      expect(spec!.sensitive).toBe(true);
    });

    it('resolves plain_note/value alias to content spec', () => {
      const spec = getCredentialFieldSpec('plain_note', 'value');
      expect(spec).toBeDefined();
      expect(spec!.key).toBe('content');
      expect(spec!.sensitive).toBe(false);
    });

    it('alias resolution is case-insensitive', () => {
      const spec = getCredentialFieldSpec('login', 'OTP');
      expect(spec).toBeDefined();
      expect(spec!.key).toBe('totp');
    });
  });

  describe('case-insensitive key lookup', () => {
    it('finds login/PASSWORD via uppercase', () => {
      const spec = getCredentialFieldSpec('login', 'PASSWORD');
      expect(spec).toBeDefined();
      expect(spec!.key).toBe('password');
      expect(spec!.sensitive).toBe(true);
    });

    it('finds card/CVV via uppercase', () => {
      const spec = getCredentialFieldSpec('card', 'CVV');
      expect(spec).toBeDefined();
      expect(spec!.key).toBe('cvv');
    });
  });

  describe('types with empty schema', () => {
    it('returns undefined for any key on api type (empty schema)', () => {
      expect(getCredentialFieldSpec('api', 'value')).toBeUndefined();
    });

    it('returns undefined for any key on custom type (empty schema)', () => {
      expect(getCredentialFieldSpec('custom', 'value')).toBeUndefined();
    });

    it('returns undefined for any key on passkey type (empty schema)', () => {
      expect(getCredentialFieldSpec('passkey', 'key')).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// resolveFieldSensitivity (not exported — tested via getCredentialFieldSpec)
//
// The private resolveFieldSensitivity function in agent.ts is:
//   function resolveFieldSensitivity(credentialType: string, fieldKey: string): boolean {
//     const schema = CREDENTIAL_FIELD_SCHEMA[credentialType as CredentialType];
//     if (!schema) return false;
//     const spec = schema.find(f => f.key.toLowerCase() === fieldKey.toLowerCase()
//       || (f.aliases || []).some(a => a.toLowerCase() === fieldKey.toLowerCase()));
//     return spec ? spec.sensitive : false;
//   }
//
// We replicate its logic here since it is not exported.
// ---------------------------------------------------------------------------

function resolveFieldSensitivity(credentialType: string, fieldKey: string): boolean {
  const schema = CREDENTIAL_FIELD_SCHEMA[credentialType as CredentialType];
  if (!schema) return false;
  const spec = schema.find(
    (f) =>
      f.key.toLowerCase() === fieldKey.toLowerCase() ||
      (f.aliases || []).some((a) => a.toLowerCase() === fieldKey.toLowerCase()),
  );
  return spec ? spec.sensitive : false;
}

describe('resolveFieldSensitivity (logic mirror)', () => {
  describe('non-sensitive schema fields', () => {
    it('returns false for login/username', () => {
      expect(resolveFieldSensitivity('login', 'username')).toBe(false);
    });

    it('returns false for card/cardholder', () => {
      expect(resolveFieldSensitivity('card', 'cardholder')).toBe(false);
    });

    it('returns false for card/brand', () => {
      expect(resolveFieldSensitivity('card', 'brand')).toBe(false);
    });

    it('returns false for sso/website', () => {
      expect(resolveFieldSensitivity('sso', 'website')).toBe(false);
    });

    it('returns false for login/url', () => {
      expect(resolveFieldSensitivity('login', 'url')).toBe(false);
    });
  });

  describe('sensitive schema fields', () => {
    it('returns true for login/password', () => {
      expect(resolveFieldSensitivity('login', 'password')).toBe(true);
    });

    it('returns true for card/cvv', () => {
      expect(resolveFieldSensitivity('card', 'cvv')).toBe(true);
    });

    it('returns true for card/number', () => {
      expect(resolveFieldSensitivity('card', 'number')).toBe(true);
    });

    it('returns true for hot_wallet/private_key', () => {
      expect(resolveFieldSensitivity('hot_wallet', 'private_key')).toBe(true);
    });

    it('returns true for login/totp', () => {
      expect(resolveFieldSensitivity('login', 'totp')).toBe(true);
    });
  });

  describe('unknown fields default to false', () => {
    it('returns false for unknown field on login', () => {
      expect(resolveFieldSensitivity('login', 'custom_field')).toBe(false);
    });

    it('returns false for unknown field on card', () => {
      expect(resolveFieldSensitivity('card', 'pin')).toBe(false);
    });
  });

  describe('unknown credential types default to false', () => {
    it('returns false for completely unknown type', () => {
      expect(resolveFieldSensitivity('nonexistent', 'password')).toBe(false);
    });

    it('returns false for empty type', () => {
      expect(resolveFieldSensitivity('', 'password')).toBe(false);
    });
  });

  describe('alias resolution', () => {
    it('resolves otp alias to totp (sensitive)', () => {
      expect(resolveFieldSensitivity('login', 'otp')).toBe(true);
    });

    it('resolves value alias to content on note (sensitive)', () => {
      expect(resolveFieldSensitivity('note', 'value')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// correctFieldSensitivity (not exported — tested via logic mirror)
//
// The private correctFieldSensitivity function in credentials.ts is:
//   function correctFieldSensitivity(type: string, fields: CredentialField[]): CredentialField[] {
//     const schema = CREDENTIAL_FIELD_SCHEMA[type as CredentialType];
//     if (!schema || schema.length === 0) return fields;
//     const specByKey = new Map(schema.map(spec => [spec.key, spec]));
//     return fields.map(field => {
//       const spec = specByKey.get(field.key);
//       if (spec && field.sensitive !== spec.sensitive) {
//         return { ...field, sensitive: spec.sensitive };
//       }
//       return field;
//     });
//   }
//
// We replicate its logic here since it is not exported.
// ---------------------------------------------------------------------------

interface CredentialField {
  key: string;
  value: string;
  type: 'text' | 'secret' | 'url' | 'email' | 'number';
  sensitive: boolean;
}

function correctFieldSensitivity(type: string, fields: CredentialField[]): CredentialField[] {
  const schema = CREDENTIAL_FIELD_SCHEMA[type as CredentialType];
  if (!schema || schema.length === 0) return fields;

  const specByKey = new Map(schema.map((spec) => [spec.key, spec]));
  return fields.map((field) => {
    const spec = specByKey.get(field.key);
    if (spec && field.sensitive !== spec.sensitive) {
      return { ...field, sensitive: spec.sensitive };
    }
    return field;
  });
}

describe('correctFieldSensitivity (logic mirror)', () => {
  describe('corrects mismarked non-sensitive fields', () => {
    it('corrects username sensitive:true to sensitive:false', () => {
      const fields: CredentialField[] = [
        { key: 'username', value: 'alice', type: 'text', sensitive: true },
      ];
      const result = correctFieldSensitivity('login', fields);
      expect(result[0].sensitive).toBe(false);
      expect(result[0].value).toBe('alice');
    });

    it('corrects card/cardholder sensitive:true to sensitive:false', () => {
      const fields: CredentialField[] = [
        { key: 'cardholder', value: 'Alice Smith', type: 'text', sensitive: true },
      ];
      const result = correctFieldSensitivity('card', fields);
      expect(result[0].sensitive).toBe(false);
    });

    it('corrects login/url sensitive:true to sensitive:false', () => {
      const fields: CredentialField[] = [
        { key: 'url', value: 'https://example.com', type: 'text', sensitive: true },
      ];
      const result = correctFieldSensitivity('login', fields);
      expect(result[0].sensitive).toBe(false);
    });
  });

  describe('preserves sensitive:true for actually sensitive fields', () => {
    it('preserves login/password as sensitive:true', () => {
      const fields: CredentialField[] = [
        { key: 'password', value: 'secret123', type: 'secret', sensitive: true },
      ];
      const result = correctFieldSensitivity('login', fields);
      expect(result[0].sensitive).toBe(true);
    });

    it('preserves card/cvv as sensitive:true', () => {
      const fields: CredentialField[] = [
        { key: 'cvv', value: '123', type: 'secret', sensitive: true },
      ];
      const result = correctFieldSensitivity('card', fields);
      expect(result[0].sensitive).toBe(true);
    });

    it('preserves card/number as sensitive:true', () => {
      const fields: CredentialField[] = [
        { key: 'number', value: '4111111111111111', type: 'text', sensitive: true },
      ];
      const result = correctFieldSensitivity('card', fields);
      expect(result[0].sensitive).toBe(true);
    });
  });

  describe('corrects sensitive:false to sensitive:true for sensitive fields', () => {
    it('corrects login/password sensitive:false to sensitive:true', () => {
      const fields: CredentialField[] = [
        { key: 'password', value: 'secret123', type: 'secret', sensitive: false },
      ];
      const result = correctFieldSensitivity('login', fields);
      expect(result[0].sensitive).toBe(true);
    });

    it('corrects card/cvv sensitive:false to sensitive:true', () => {
      const fields: CredentialField[] = [
        { key: 'cvv', value: '123', type: 'secret', sensitive: false },
      ];
      const result = correctFieldSensitivity('card', fields);
      expect(result[0].sensitive).toBe(true);
    });
  });

  describe('leaves unknown fields unchanged', () => {
    it('does not modify fields with keys not in the schema', () => {
      const fields: CredentialField[] = [
        { key: 'custom_field', value: 'foo', type: 'text', sensitive: true },
      ];
      const result = correctFieldSensitivity('login', fields);
      expect(result[0]).toEqual(fields[0]);
      // Verify it's the same object reference (no copy made)
      expect(result[0]).toBe(fields[0]);
    });

    it('preserves unknown field with sensitive:false', () => {
      const fields: CredentialField[] = [
        { key: 'unknown_key', value: 'bar', type: 'text', sensitive: false },
      ];
      const result = correctFieldSensitivity('card', fields);
      expect(result[0]).toBe(fields[0]);
    });
  });

  describe('returns fields unchanged for unknown credential types', () => {
    it('returns fields as-is for unknown type', () => {
      const fields: CredentialField[] = [
        { key: 'password', value: 'secret', type: 'secret', sensitive: true },
        { key: 'username', value: 'alice', type: 'text', sensitive: false },
      ];
      const result = correctFieldSensitivity('nonexistent_type', fields);
      expect(result).toBe(fields);
    });

    it('returns fields as-is for empty type', () => {
      const fields: CredentialField[] = [
        { key: 'key', value: 'val', type: 'text', sensitive: true },
      ];
      const result = correctFieldSensitivity('', fields);
      expect(result).toBe(fields);
    });
  });

  describe('returns fields unchanged for types with empty schemas', () => {
    it('returns fields as-is for api type (empty schema)', () => {
      const fields: CredentialField[] = [
        { key: 'value', value: 'apikey123', type: 'secret', sensitive: true },
      ];
      const result = correctFieldSensitivity('api', fields);
      expect(result).toBe(fields);
    });

    it('returns fields as-is for custom type (empty schema)', () => {
      const fields: CredentialField[] = [
        { key: 'value', value: 'data', type: 'text', sensitive: false },
      ];
      const result = correctFieldSensitivity('custom', fields);
      expect(result).toBe(fields);
    });
  });

  describe('handles mixed field lists', () => {
    it('corrects each field independently in a multi-field credential', () => {
      const fields: CredentialField[] = [
        { key: 'username', value: 'alice', type: 'text', sensitive: true },   // should become false
        { key: 'password', value: 'secret', type: 'secret', sensitive: true }, // should stay true
        { key: 'url', value: 'https://x.com', type: 'text', sensitive: true }, // should become false
        { key: 'custom', value: 'extra', type: 'text', sensitive: true },      // unknown, unchanged
      ];
      const result = correctFieldSensitivity('login', fields);
      expect(result[0].sensitive).toBe(false);  // username corrected
      expect(result[1].sensitive).toBe(true);   // password preserved
      expect(result[2].sensitive).toBe(false);  // url corrected
      expect(result[3].sensitive).toBe(true);   // custom unchanged
      expect(result[3]).toBe(fields[3]);         // custom same reference
    });
  });
});
