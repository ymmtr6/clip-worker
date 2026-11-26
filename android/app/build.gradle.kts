plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// エミュレータから wrangler dev に繋ぐとき: ./gradlew installDebug -PclipOrigin=http://10.0.2.2:8787/ -PclipDevToken=dev
val clipOrigin = (findProperty("clipOrigin") as String?) ?: "https://clip.riyamamo.com/"
val clipDevToken = (findProperty("clipDevToken") as String?) ?: ""

android {
    namespace = "com.riyamamo.movieclip"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.riyamamo.movieclip"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "CLIP_ORIGIN", "\"https://clip.riyamamo.com/\"")
        buildConfigField("String", "DEV_TOKEN", "\"\"")
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }

    buildTypes {
        debug {
            buildConfigField("String", "CLIP_ORIGIN", "\"$clipOrigin\"")
            buildConfigField("String", "DEV_TOKEN", "\"$clipDevToken\"")
            manifestPlaceholders["usesCleartextTraffic"] = clipOrigin.startsWith("http://").toString()
        }
        release {
            isMinifyEnabled = false
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-ui:1.5.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("io.coil-kt:coil-compose:2.7.0")
}
