import {
	MAX_PARTS,
	MAX_UPLOAD_BYTES,
	MIN_PART_BYTES,
	extensionFor,
	needsMultipart,
	partCountFor,
	partSizeFor,
} from './upload-policy'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

describe('upload policy', () => {
	it('splits a 12 MiB file into three parts of at least 5 MiB', () => {
		const size = 12 * MiB
		expect(needsMultipart(size)).toBe(true)
		expect(partSizeFor(size)).toBe(MIN_PART_BYTES)
		expect(partCountFor(size, partSizeFor(size))).toBe(3)
	})

	it('keeps small files on a single PUT', () => {
		expect(needsMultipart(2 * MiB)).toBe(false)
	})

	it('grows the part size so a large file stays within 10 000 parts', () => {
		for (const size of [50 * GiB + 1, 100 * GiB - 7, MAX_UPLOAD_BYTES]) {
			const partSize = partSizeFor(size)
			expect(partSize).toBeGreaterThan(MIN_PART_BYTES)
			expect(partCountFor(size, partSize)).toBeLessThanOrEqual(MAX_PARTS)
		}
	})

	it('derives the extension from the content type, never from a filename', () => {
		expect(extensionFor('image/PNG')).toBe('png')
		expect(extensionFor('text/html')).toBeUndefined()
	})
})
