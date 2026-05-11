# Gondolin Guest Profiles

Runtime templates select a Gondolin guest profile with `gondolin_profile`.
Profiles are prebuilt Gondolin guest asset directories, not ad hoc installs in
the outer Node runtime container.

Expected runtime layout:

```text
/gondolin-profiles/
  python/
    vmlinuz-virt
    initramfs.cpio.lz4
    rootfs.ext4
  media/
    vmlinuz-virt
    initramfs.cpio.lz4
    rootfs.ext4
```

Development setup:

1. Build or obtain the Gondolin guest profile assets you need.
2. Put each profile under a directory named by the template profile, for example
   `python` or `media`.
3. Set backend runtime provisioning env:

```text
GONDOLIN_PROFILE_ASSETS_HOST_DIR=/absolute/path/to/gondolin-profiles
GONDOLIN_PROFILE_ASSETS_CONTAINER_DIR=/gondolin-profiles
```

Lazy runtime containers mount that host directory read-only. The runtime agent
then resolves `/gondolin-profiles/<profile>` and passes it to
`VM.create({ sandbox: { imagePath } })`.

Use `base` when the default Gondolin guest image is enough. Non-base profiles
fail at VM startup if the profile assets are not mounted or explicitly mapped
with `GONDOLIN_PROFILE_PATHS`.
