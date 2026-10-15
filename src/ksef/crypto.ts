import { X509Certificate, constants, publicEncrypt } from 'node:crypto'

/** RSA-OAEP (SHA-256) encryption of "<token>|<timestampMs>" with the KsefTokenEncryption certificate. */
export function encryptKsefToken(token: string, timestampMs: number, certificateBase64: string): string {
  const cert = new X509Certificate(Buffer.from(certificateBase64, 'base64'))
  const encrypted = publicEncrypt(
    { key: cert.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`${token}|${timestampMs}`, 'utf8'),
  )
  return encrypted.toString('base64')
}
