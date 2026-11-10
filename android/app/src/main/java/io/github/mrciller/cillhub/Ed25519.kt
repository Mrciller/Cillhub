package io.github.mrciller.cillhub

import java.math.BigInteger
import java.security.MessageDigest

/**
 * Ed25519 signature verification (RFC 8032) on BigInteger: the platform only offers it from Android 13, and only the
 * update feed's signature is ever checked (once a day), so speed does not matter. Verification only, no key handling.
 */
object Ed25519 {
    private val P = BigInteger.valueOf(2).pow(255) - BigInteger.valueOf(19)
    private val L = BigInteger.valueOf(2).pow(252) + BigInteger("27742317777372353535851937790883648493")
    private val D = BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P)
    private val I = BigInteger.valueOf(2).modPow((P - BigInteger.ONE).shiftRight(2), P) // sqrt(-1)
    private val B = Point(recoverX(BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P), false)!!, BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P))

    private class Point(val x: BigInteger, val y: BigInteger)

    // twisted Edwards addition with a = -1 (affine; one modular inverse per addition)
    private fun add(p: Point, q: Point): Point {
        val xx = p.x * q.x
        val yy = p.y * q.y
        val dxy = D * xx * yy
        val x = (p.x * q.y + q.x * p.y) * (BigInteger.ONE + dxy).modInverse(P)
        val y = (yy + xx) * (BigInteger.ONE - dxy).modInverse(P)
        return Point(x.mod(P), y.mod(P))
    }

    private fun mul(p: Point, k: BigInteger): Point {
        var r = Point(BigInteger.ZERO, BigInteger.ONE)
        var q = p
        for (i in 0 until k.bitLength()) {
            if (k.testBit(i)) r = add(r, q)
            q = add(q, q)
        }
        return r
    }

    private fun recoverX(y: BigInteger, odd: Boolean): BigInteger? {
        val y2 = y * y
        val u = (y2 - BigInteger.ONE).mod(P)
        val v = (D * y2 + BigInteger.ONE).mod(P)
        var x = (u * v.modPow(BigInteger.valueOf(3), P) * (u * v.modPow(BigInteger.valueOf(7), P)).modPow((P - BigInteger.valueOf(5)).shiftRight(3), P)).mod(P)
        if ((v * x * x).mod(P) != u) x = (x * I).mod(P)
        if ((v * x * x).mod(P) != u) return null
        if (x == BigInteger.ZERO && odd) return null
        return if (x.testBit(0) != odd) P - x else x
    }

    private fun decode(b: ByteArray): Point? {
        if (b.size != 32) return null
        val le = b.reversedArray()
        val odd = le[0].toInt() and 0x80 != 0
        le[0] = (le[0].toInt() and 0x7f).toByte()
        val y = BigInteger(1, le)
        if (y >= P) return null
        return Point(recoverX(y, odd) ?: return null, y)
    }

    private fun encode(p: Point): ByteArray {
        val out = p.y.toByteArray().reversedArray().copyOf(32)
        if (p.x.testBit(0)) out[31] = (out[31].toInt() or 0x80).toByte()
        return out
    }

    /** True when `sig` (64 bytes) is a valid Ed25519 signature of `msg` under the raw 32-byte public key `pub`. */
    fun verify(pub: ByteArray, msg: ByteArray, sig: ByteArray): Boolean {
        if (sig.size != 64) return false
        val a = decode(pub) ?: return false
        val r = decode(sig.copyOfRange(0, 32)) ?: return false
        val s = BigInteger(1, sig.copyOfRange(32, 64).reversedArray())
        if (s >= L) return false
        val h = MessageDigest.getInstance("SHA-512").run { update(sig, 0, 32); update(pub); update(msg); digest() }
        val k = BigInteger(1, h.reversedArray()).mod(L)
        return encode(mul(B, s)).contentEquals(encode(add(r, mul(a, k))))
    }
}
