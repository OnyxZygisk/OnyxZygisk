#!/usr/bin/env python3
"""Host check for the Nubia Android 16 Zygote JNI variants.

The descriptors below were observed on an NX888J. This test needs neither a
device framework.jar nor an Android build toolchain.
"""

import os
from pathlib import Path
import re
import runpy
import tempfile


HERE = Path(__file__).resolve().parent
NUBIA_DESCRIPTORS = {
    "fas_nubia_u": "(II[II[[IILjava/lang/String;Ljava/lang/String;[I[IZLjava/lang/String;Ljava/lang/String;Z[Ljava/lang/String;[Ljava/lang/String;ZZZLjava/lang/String;)I",
    "spec_nubia_u": "(II[II[[IILjava/lang/String;Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;Z[Ljava/lang/String;[Ljava/lang/String;ZZZLjava/lang/String;)V",
}


def check_forwarding(header, method):
    descriptor = f'"{method.jni()}"'
    assert header.count(descriptor) == 1, f"expected one wrapper for {method.name}"
    start = header.index(descriptor)
    end = header.index("\n    },", start)
    wrapper = header[start:end]

    # The lambda and the cast of the original JNI entry must agree exactly.
    signature = f"JNIEnv *env, jclass clazz, {method.cpp()}"
    assert wrapper.count(signature) == 2, f"JNI parameter mismatch: {method.name}"
    call = re.search(r"\n\s*env, clazz, ([^\n]+)\n\s*\);", wrapper)
    assert call is not None, f"missing original JNI call: {method.name}"
    assert call.group(1) == method.name_list(), f"JNI arguments changed: {method.name}"
    assert wrapper.count("vendor_extra") == 3, f"opaque String not forwarded: {method.name}"


def main():
    checked_in = (HERE / "jni_hooks.hpp").read_bytes()
    previous_directory = Path.cwd()
    with tempfile.TemporaryDirectory() as temporary_directory:
        try:
            os.chdir(temporary_directory)
            definitions = runpy.run_path(str(HERE / "gen_jni_hooks.py"))
            regenerated = Path("jni_hooks.hpp").read_bytes()
        finally:
            os.chdir(previous_directory)
    assert regenerated == checked_in, "jni_hooks.hpp differs from generator output"

    header = checked_in.decode("utf-8")
    for vendor, standard in (("fas_nubia_u", "fas_u"),
                             ("spec_nubia_u", "spec_u")):
        method = definitions[vendor]
        base = definitions[standard]
        assert method.jni() == NUBIA_DESCRIPTORS[vendor], f"wrong descriptor: {vendor}"
        assert [(arg.name, arg.type.jni) for arg in method.args[:-1]] == [
            (arg.name, arg.type.jni) for arg in base.args
        ], f"standard JNI arguments changed: {vendor}"
        assert (method.args[-1].name, method.args[-1].type.jni) == (
            "vendor_extra", "Ljava/lang/String;"
        ), f"missing trailing String: {vendor}"
        check_forwarding(header, method)

    print("test_jni_hooks: PASS")


if __name__ == "__main__":
    main()
