# Adversarial review reports

`swamp extension push` looks for a review report under the system temp
directory, at a path bound to the content hash of the extension. Temp
directories do not survive, and the hash moves on any source change — so the
reports are kept here too, under the swamp-extension-review/ subdirectory the
tool expects, and a push can find them with:

```bash
SWAMP_EXTENSION_REVIEW_DIR=$PWD/extensions/hermes/.reviews \
  swamp extension push extensions/hermes/manifest.yaml --dry-run
```

A report here whose hash matches no current source is a review of an older
version. That is the intended behaviour, not stale clutter: it is the record of
what was reviewed when.
