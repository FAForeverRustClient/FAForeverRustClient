package com.faforever.rustclient

import android.os.Bundle
import android.system.Os
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Before the client starts (TauriActivity's onCreate). It finds its folders as a
    // Linux program does, under HOME, which an app's process does not have: the
    // app's own private folders take its place.
    Os.setenv("HOME", filesDir.absolutePath, true)
    Os.setenv("TMPDIR", cacheDir.absolutePath, true)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // From edge to edge the page would lie under the status and navigation bars
    // and the camera's cut-out, which a page made for a desktop window knows
    // nothing of: it is kept between them, and above the keyboard while one is up.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }
}
