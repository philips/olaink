package com.olaink.svgprobe;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.util.Log;
import android.view.View;

import androidx.annotation.NonNull;

import java.io.File;

/**
 * Playback experiment for the supplied raster-backed SVG. It deliberately
 * performs a page wipe, not a false stroke replay: the source has no paths.
 */
final class AnimatedSvgRasterWipeView extends View {
  private static final String TAG = "OlaInkSvgProbe";
  private static final String PLUGIN_ID = "olainksvgprobe0001";
  private static final String ASSET_NAME = "supplied-note-background.png";
  private static final long DURATION_MS = 8000L;
  private static final int FPS = 10;
  private static final int FRAMES = (int) (DURATION_MS * FPS / 1000L);

  private final Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Runnable tick = new Runnable() {
    @Override
    public void run() {
      scheduled = false;
      if (!playing || disposed) return;
      frame = frame >= FRAMES ? 0 : frame + 1;
      if (frame % FPS == 0) Log.i(TAG, "raster wipe frame=" + frame + "/" + FRAMES);
      invalidate();
      schedule();
    }
  };

  private Bitmap page;
  private boolean playing = true;
  private boolean disposed;
  private boolean scheduled;
  private int frame;

  AnimatedSvgRasterWipeView(@NonNull Context context) {
    super(context);
    setWillNotDraw(false);
    borderPaint.setColor(0xff111111);
    borderPaint.setStyle(Paint.Style.STROKE);
    borderPaint.setStrokeWidth(2f);
    labelPaint.setColor(0xff28251f);
    labelPaint.setTextSize(24f);
    labelPaint.setTypeface(android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE,
        android.graphics.Typeface.BOLD));
    final File file = new File(new File(context.getFilesDir(), "plugins" + File.separator + PLUGIN_ID),
        ASSET_NAME);
    page = BitmapFactory.decodeFile(file.getAbsolutePath());
    Log.i(TAG, "raster source " + (page == null ? "unavailable" : page.getWidth() + "x" + page.getHeight())
        + " path=" + file.getAbsolutePath());
    schedule();
  }

  void setPlaying(boolean value) {
    playing = value;
    if (playing) schedule();
    else {
      removeCallbacks(tick);
      scheduled = false;
    }
    invalidate();
  }

  void restart() {
    removeCallbacks(tick);
    scheduled = false;
    frame = 0;
    Log.i(TAG, "raster wipe replay requested");
    invalidate();
    schedule();
  }

  void dispose() {
    disposed = true;
    removeCallbacks(tick);
    scheduled = false;
    if (page != null) {
      page.recycle();
      page = null;
    }
  }

  private void schedule() {
    if (!disposed && playing && !scheduled) {
      scheduled = true;
      postDelayed(tick, 1000L / FPS);
    }
  }

  @Override
  protected void onDetachedFromWindow() {
    dispose();
    super.onDetachedFromWindow();
  }

  @Override
  protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);
    canvas.drawColor(0xfff7f4ed);
    final float progress = frame / (float) FRAMES;
    canvas.drawText("RASTER TOP-TO-BOTTOM WIPE / 8 SEC / 10 FPS", 24f, 38f, labelPaint);
    canvas.drawText(Math.round(progress * 100f) + "%", getWidth() - 85f, 38f, labelPaint);
    if (page == null) {
      canvas.drawText("Supplied raster asset was not found", 24f, 90f, labelPaint);
      return;
    }
    final float availableTop = 58f;
    final float scale = Math.min(getWidth() / (float) page.getWidth(),
        (getHeight() - availableTop) / (float) page.getHeight());
    final float width = page.getWidth() * scale;
    final float height = page.getHeight() * scale;
    final float left = (getWidth() - width) / 2f;
    final float top = availableTop + (getHeight() - availableTop - height) / 2f;
    final RectF destination = new RectF(left, top, left + width, top + height);
    canvas.drawRect(destination, borderPaint);
    canvas.save();
    canvas.clipRect(left, top, left + width, top + height * progress);
    canvas.drawBitmap(page, new Rect(0, 0, page.getWidth(), page.getHeight()), destination, null);
    canvas.restore();
  }
}
