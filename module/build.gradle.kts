import android.databinding.tool.ext.capitalizeUS
import java.security.MessageDigest
import org.apache.tools.ant.filters.ReplaceTokens

import org.apache.tools.ant.filters.FixCrLfFilter

import org.apache.commons.codec.binary.Hex
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.EdECPrivateKey
import java.security.interfaces.EdECPublicKey
import java.security.spec.EdECPrivateKeySpec
import java.security.spec.NamedParameterSpec
import java.util.TreeSet

plugins {
    alias(libs.plugins.agp.lib)
}

val moduleId: String by rootProject.extra
val moduleName: String by rootProject.extra
val verCode: Int by rootProject.extra
val verName: String by rootProject.extra
val minAPatchVersion: Int by rootProject.extra
val minKsuVersion: Int by rootProject.extra
val minKsudVersion: Int by rootProject.extra
val maxKsuVersion: Int by rootProject.extra
val minMagiskVersion: Int by rootProject.extra
val workDirectory: String by rootProject.extra
val commitHash: String by rootProject.extra

/** pnpm binary name on the current platform (pnpm.cmd on Windows). */
fun pnpmCommand(): String =
    if (System.getProperty("os.name").lowercase().contains("win")) "pnpm.cmd" else "pnpm"

// The WebUI is a Vue 3 + Vite + TypeScript project living in zygiskd/webui.
// `webuiInstall` bootstraps dependencies once (pnpm install --frozen-lockfile,
// only when node_modules is missing); `webuiBuild` runs the production build
// into zygiskd/webui/dist/, which is what ships as the module's `webroot/`.
// Building the module zip therefore requires pnpm (Node.js >= 18).
val webuiInstall = task<Exec>("webuiInstall") {
    group = "webui"
    workingDir = file("$rootDir/zygiskd/webui")
    commandLine(pnpmCommand(), "install", "--frozen-lockfile")
    outputs.dir(file("$rootDir/zygiskd/webui/node_modules"))
    onlyIf { !file("$rootDir/zygiskd/webui/node_modules").exists() }
}

val webuiBuild = task<Exec>("webuiBuild") {
    group = "webui"
    dependsOn(webuiInstall)
    workingDir = file("$rootDir/zygiskd/webui")
    commandLine(pnpmCommand(), "run", "build")
    inputs.dir(file("$rootDir/zygiskd/webui/src"))
    inputs.dir(file("$rootDir/zygiskd/webui/public"))
    inputs.files(
        file("$rootDir/zygiskd/webui/package.json"),
        file("$rootDir/zygiskd/webui/package-lock.json"),
        file("$rootDir/zygiskd/webui/vite.config.ts"),
        file("$rootDir/zygiskd/webui/tsconfig.json"),
        file("$rootDir/zygiskd/webui/index.html"),
    )
    outputs.dir(file("$rootDir/zygiskd/webui/dist"))
}

android {
    buildFeatures {
        buildConfig = false
    }
    androidResources.enable = false
}

androidComponents.onVariants { variant ->
    val variantLowered = variant.name.lowercase()
    val variantCapped = variant.name.capitalizeUS()
    val buildTypeLowered = variant.buildType?.lowercase()

    val moduleDir = layout.buildDirectory.dir("outputs/module/$variantLowered")
    val zipFileName = "$moduleName-$verName-$verCode-$commitHash-$buildTypeLowered.zip".replace(' ', '-')

    val prepareModuleFilesTask = task<Sync>("prepareModuleFiles$variantCapped") {
        group = "module"
        dependsOn(
            ":loader:assemble$variantCapped",
            ":zygiskd:buildAndStrip$variantCapped",
            webuiBuild,
        )
        // Force UTF-8 for content filtering (ReplaceTokens / FixCrLf / expand).
        // Without this Gradle uses the platform default charset (GBK on Windows),
        // which corrupts non-ASCII (Chinese / emoji) in action.sh, module.prop, etc.
        filteringCharset = "UTF-8"
        into(moduleDir)
        from("${rootProject.projectDir}/README.md")
        from("$projectDir/src") {
            // Text files only: run them through the CRLF filter. Binary assets
            // (banner etc.) must NOT be filtered or they get corrupted.
            exclude(
                "module.prop", "action.sh", "customize.sh", "post-fs-data.sh",
                "late-load.sh", "zygisk-init.sh",
                "service.sh", "uninstall.sh", "zygisk-ctl.sh",
                "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp", "**/*.gif", "**/*.ico",
            )
            filter<FixCrLfFilter>("eol" to FixCrLfFilter.CrLf.newInstance("lf"))
        }
        // Binary assets are copied verbatim (no filtering).
        from("$projectDir/src") {
            include("**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.webp", "**/*.gif", "**/*.ico")
        }
        from("$projectDir/src") {
            include("module.prop")
            expand(
                "moduleId" to moduleId,
                "moduleName" to moduleName,
                // Keep the version line clean; build metadata stays in the
                // zip file name only (OnyxZygisk-v1.0.5-329-<hash>-release.zip).
                "versionName" to verName,
                "versionCode" to verCode
            )
        }
        from("$projectDir/src") {
            include(
                "action.sh", "customize.sh", "post-fs-data.sh", "late-load.sh",
                "zygisk-init.sh", "service.sh", "uninstall.sh", "zygisk-ctl.sh",
            )
            val tokens = mapOf(
                "DEBUG" to if (buildTypeLowered == "debug") "true" else "false",
                "MIN_APATCH_VERSION" to "$minAPatchVersion",
                "MIN_KSU_VERSION" to "$minKsuVersion",
                "MIN_KSUD_VERSION" to "$minKsudVersion",
                "MAX_KSU_VERSION" to "$maxKsuVersion",
                "MIN_MAGISK_VERSION" to "$minMagiskVersion",
                "WORK_DIRECTORY" to "$workDirectory",
            )
            filter<ReplaceTokens>("tokens" to tokens)
            filter<FixCrLfFilter>("eol" to FixCrLfFilter.CrLf.newInstance("lf"))
        }
        into("bin") {
            from(project(":zygiskd").layout.buildDirectory.dir("intermediates/rust/$buildTypeLowered/jniLibs"))
            include("**/zygiskd")
        }
        // The WebUI ships as static files in the module's `webroot/` directory
        // (KernelSU webroot convention): root manager apps load the page
        // directly from there, no daemon involvement. The files come from the
        // Vite build output (zygiskd/webui/dist); see the `webuiBuild` task
        // above. `customize.sh` extracts this directory on install
        // (SKIPUNZIP=1 mode).
        into("webroot") {
            from("$rootDir/zygiskd/webui/dist")
        }
        into("lib") {
            from(project(":loader").layout.buildDirectory.dir("intermediates/stripped_native_libs/$variantLowered/strip${variantCapped}DebugSymbols/out/lib"))
        }

        doLast {
            fileTree(moduleDir).visit {
                if (isDirectory) return@visit
                val md = MessageDigest.getInstance("SHA-256")
                file.forEachBlock(4096) { bytes, size ->
                    md.update(bytes, 0, size)
                }
                file(file.path + ".sha256").writeText(Hex.encodeHexString(md.digest()))
            }
        }
    }

    val zipTask = task<Zip>("zip$variantCapped") {
        group = "module"
        dependsOn(prepareModuleFilesTask)
        archiveFileName.set(zipFileName)
        destinationDirectory.set(layout.buildDirectory.dir("outputs/release").get().asFile)
        from(moduleDir)
    }

    val pushTask = task<Exec>("push$variantCapped") {
        group = "module"
        dependsOn(zipTask)
        commandLine("adb", "push", zipTask.outputs.files.singleFile.path, "/data/local/tmp")
    }

    val installAPatchTask = task("installAPatch$variantCapped") {
        group = "module"
        dependsOn(pushTask)
        doLast {
            providers.exec {
                commandLine(
                    "adb", "shell", "echo",
                    "/data/adb/apd module install /data/local/tmp/$zipFileName",
                    "> /data/local/tmp/install.sh"
                )
            }.result.get()
            providers.exec { commandLine("adb", "shell", "chmod", "755", "/data/local/tmp/install.sh") }.result.get()
            providers.exec { commandLine("adb", "shell", "su", "-c", "/data/local/tmp/install.sh") }.result.get()
        }
    }

    val installKsuTask = task("installKsu$variantCapped") {
        group = "module"
        dependsOn(pushTask)
        doLast {
            providers.exec {
                commandLine(
                    "adb", "shell", "echo",
                    "/data/adb/ksud module install /data/local/tmp/$zipFileName",
                    "> /data/local/tmp/install.sh"
                )
            }.result.get()
            providers.exec { commandLine("adb", "shell", "chmod", "755", "/data/local/tmp/install.sh") }.result.get()
            providers.exec { commandLine("adb", "shell", "su", "-c", "/data/local/tmp/install.sh") }.result.get()
        }
    }

    val installMagiskTask = task<Exec>("installMagisk$variantCapped") {
        group = "module"
        dependsOn(pushTask)
        commandLine("adb", "shell", "su", "-M", "-c", "magisk --install-module /data/local/tmp/$zipFileName")
    }

    task<Exec>("installAPatchAndReboot$variantCapped") {
        group = "module"
        dependsOn(installAPatchTask)
        commandLine("adb", "reboot")
    }

    task<Exec>("installKsuAndReboot$variantCapped") {
        group = "module"
        dependsOn(installKsuTask)
        commandLine("adb", "reboot")
    }

    task<Exec>("installMagiskAndReboot$variantCapped") {
        group = "module"
        dependsOn(installMagiskTask)
        commandLine("adb", "reboot")
    }
}
