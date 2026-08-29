package com.olaink.svgprobe;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PathMeasure;
import android.util.Log;
import android.view.View;

import androidx.annotation.NonNull;

/** Fixed native 2×3 timing grid; avoids PluginHost's multi-native-view layout. */
final class AnimatedSvgSpeedGridView extends View {
  private static final String TAG = "OlaInkSvgProbe";
  private static final float WIDTH = 1000f;
  private static final float HEIGHT = 700f;
  private static final int HOST_FPS = 15;
  private static final int CYCLE_MS = 8000;
  private static final int CYCLE_FRAMES = CYCLE_MS * HOST_FPS / 1000;
  private static final String PATH_DATA =
      "M90 445 C170 180 275 540 365 310 S535 180 610 390 S765 525 890 215";
  private static final Preset[] PRESETS = {
      new Preset("4 SEC / 5 FPS", 4000, 5),
      new Preset("4 SEC / 10 FPS", 4000, 10),
      new Preset("6 SEC / 10 FPS", 6000, 10),
      new Preset("8 SEC / 10 FPS", 8000, 10),
      new Preset("6 SEC / 15 FPS", 6000, 15),
      new Preset("8 SEC / 15 FPS", 8000, 15),
  };

  private final Paint borderPaint = stroke(0xff8f8a82, 2f);
  private final Paint inkPaint = stroke(0xff111111, 16f);
  private final Paint tipPaint = fill(0xffcf3c25);
  private final Paint labelPaint = text(0xff28251f, 23f);
  private final Paint percentPaint = text(0xff28251f, 19f);
  private final Path sourcePath = parsePath(PATH_DATA);
  private final PathMeasure measure = new PathMeasure(sourcePath, false);
  private final Path visiblePath = new Path();
  private final float[] tip = new float[2];
  private final Runnable tick = new Runnable() {
    @Override
    public void run() {
      tickScheduled = false;
      if (!playing || disposed) return;
      frame = frame >= CYCLE_FRAMES ? 0 : frame + 1;
      if (frame % HOST_FPS == 0) Log.i(TAG, "grid frame=" + frame + "/" + CYCLE_FRAMES);
      invalidate();
      schedule();
    }
  };

  private boolean playing = true;
  private boolean disposed;
  private boolean tickScheduled;
  private int frame;

  AnimatedSvgSpeedGridView(@NonNull Context context) {
    super(context);
    setWillNotDraw(false);
    Log.i(TAG, "speed grid created: six presets, hostFps=" + HOST_FPS);
    schedule();
  }

  void setPlaying(boolean value) {
    playing = value;
    if (playing) schedule();
    else {
      removeCallbacks(tick);
      tickScheduled = false;
    }
    invalidate();
  }

  void restart() {
    removeCallbacks(tick);
    tickScheduled = false;
    frame = 0;
    Log.i(TAG, "speed grid replay requested");
    invalidate();
    schedule();
  }

  void dispose() {
    disposed = true;
    removeCallbacks(tick);
    tickScheduled = false;
  }

  private void schedule() {
    if (!disposed && playing && !tickScheduled) {
      tickScheduled = true;
      postDelayed(tick, 1000L / HOST_FPS);
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
    final float scale = Math.min(getWidth() / WIDTH, getHeight() / HEIGHT);
    final float offsetX = (getWidth() - WIDTH * scale) / 2f;
    final float offsetY = (getHeight() - HEIGHT * scale) / 2f;
    canvas.save();
    canvas.translate(offsetX, offsetY);
    canvas.scale(scale, scale);
    for (int index = 0; index < PRESETS.length; index++) {
      drawCell(canvas, PRESETS[index], index % 2, index / 2);
    }
    canvas.restore();
  }

  private void drawCell(Canvas canvas, Preset preset, int column, int row) {
    final float left = 28f + column * 488f;
    final float top = 26f + row * 222f;
    final float width = 456f;
    final float height = 196f;
    canvas.drawRect(left, top, left + width, top + height, borderPaint);
    canvas.drawText(preset.label, left + 13f, top + 28f, labelPaint);

    final int elapsedMs = frame * 1000 / HOST_FPS;
    final int localMs = elapsedMs % preset.durationMs;
    final int visibleFrame = localMs * preset.fps / 1000;
    final int totalFrames = preset.durationMs * preset.fps / 1000;
    final float progress = visibleFrame / (float) totalFrames;
    canvas.drawText(Math.round(progress * 100f) + "%", left + width - 47f, top + 28f, percentPaint);

    final float innerLeft = left + 12f;
    final float innerTop = top + 42f;
    final float innerWidth = width - 24f;
    final float innerHeight = height - 55f;
    canvas.drawLine(innerLeft, innerTop + innerHeight - 8f, innerLeft + innerWidth,
        innerTop + innerHeight - 8f, borderPaint);
    final float pathScale = Math.min(innerWidth / 1000f, innerHeight / 650f);
    canvas.save();
    canvas.translate(innerLeft + (innerWidth - 1000f * pathScale) / 2f,
        innerTop + (innerHeight - 650f * pathScale) / 2f);
    canvas.scale(pathScale, pathScale);
    visiblePath.reset();
    final float distance = measure.getLength() * progress;
    if (distance > 0f) measure.getSegment(0f, distance, visiblePath, true);
    canvas.drawPath(visiblePath, inkPaint);
    if (progress > 0f) {
      measure.getPosTan(distance, tip, null);
      canvas.drawCircle(tip[0], tip[1], 13f, tipPaint);
    }
    canvas.restore();
  }

  private static Paint stroke(int color, float width) {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(color);
    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(width);
    paint.setStrokeCap(Paint.Cap.ROUND);
    paint.setStrokeJoin(Paint.Join.ROUND);
    return paint;
  }

  private static Paint fill(int color) {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(color);
    return paint;
  }

  private static Paint text(int color, float size) {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(color);
    paint.setTextSize(size);
    paint.setTypeface(android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE,
        android.graphics.Typeface.BOLD));
    return paint;
  }

  // Supports only this probe's absolute M, C, and S SVG path commands.
  private static Path parsePath(String data) {
    final String[] tokens = data.replaceAll("([A-Za-z])", " $1 ").trim().split("\\s+");
    final Path path = new Path();
    int index = 0;
    float x = 0f, y = 0f, controlX = 0f, controlY = 0f;
    while (index < tokens.length) {
      switch (tokens[index++]) {
        case "M":
          x = number(tokens, index++); y = number(tokens, index++); path.moveTo(x, y); break;
        case "C": {
          float x1 = number(tokens, index++), y1 = number(tokens, index++);
          controlX = number(tokens, index++); controlY = number(tokens, index++);
          x = number(tokens, index++); y = number(tokens, index++);
          path.cubicTo(x1, y1, controlX, controlY, x, y); break;
        }
        case "S": {
          float x1 = 2f * x - controlX, y1 = 2f * y - controlY;
          controlX = number(tokens, index++); controlY = number(tokens, index++);
          x = number(tokens, index++); y = number(tokens, index++);
          path.cubicTo(x1, y1, controlX, controlY, x, y); break;
        }
        default: throw new IllegalArgumentException("unsupported SVG command");
      }
    }
    return path;
  }

  private static float number(String[] tokens, int index) {
    return Float.parseFloat(tokens[index]);
  }

  private static final class Preset {
    final String label;
    final int durationMs;
    final int fps;
    Preset(String label, int durationMs, int fps) {
      this.label = label;
      this.durationMs = durationMs;
      this.fps = fps;
    }
  }
}
