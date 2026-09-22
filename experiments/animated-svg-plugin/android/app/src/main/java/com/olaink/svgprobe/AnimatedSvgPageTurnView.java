package com.olaink.svgprobe;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PathMeasure;
import android.util.Log;
import android.view.View;

import androidx.annotation.NonNull;

/**
 * Two-page native timeline test. A completed page holds for exactly one second
 * before the next page replaces it in the same viewport and begins at zero.
 */
final class AnimatedSvgPageTurnView extends View {
  private static final String TAG = "OlaInkSvgProbe";
  private static final float VIEWBOX_WIDTH = 1000f;
  private static final float VIEWBOX_HEIGHT = 650f;
  private static final int FPS = 10;
  private static final long PAGE_DRAW_MS = 4000L;
  private static final long PAGE_TURN_HOLD_MS = 1000L;
  private static final int PAGE_FRAMES = (int) (PAGE_DRAW_MS * FPS / 1000L);
  private static final String[] PAGE_PATHS = {
      "M90 445 C170 180 275 540 365 310 S535 180 610 390 S765 525 890 215",
      "M90 245 C150 480 260 90 365 330 S525 560 620 235 S765 80 890 410"
  };

  private final Paint borderPaint = stroke(0xffaaa59c, 3f);
  private final Paint inkPaint = stroke(0xff111111, 18f);
  private final Paint tipPaint = fill(0xffcf3c25);
  private final Paint labelPaint = text(0xff28251f, 30f);
  private final Path[] paths = {parsePath(PAGE_PATHS[0]), parsePath(PAGE_PATHS[1])};
  private final PathMeasure[] measures = {new PathMeasure(paths[0], false), new PathMeasure(paths[1], false)};
  private final Path visible = new Path();
  private final float[] tip = new float[2];
  private final Runnable tick = new Runnable() {
    @Override
    public void run() {
      scheduled = false;
      if (!playing || disposed) return;
      if (holding) {
        holding = false;
        page = (page + 1) % paths.length;
        frame = 0;
        Log.i(TAG, "page turn complete: starting page=" + (page + 1));
        invalidate();
        scheduleFrame();
        return;
      }
      frame += 1;
      if (frame >= PAGE_FRAMES) {
        frame = PAGE_FRAMES;
        holding = true;
        Log.i(TAG, "page=" + (page + 1) + " drawing complete; holding " + PAGE_TURN_HOLD_MS + "ms");
        invalidate();
        schedule(PAGE_TURN_HOLD_MS);
        return;
      }
      invalidate();
      scheduleFrame();
    }
  };

  private boolean playing = true;
  private boolean holding;
  private boolean disposed;
  private boolean scheduled;
  private int page;
  private int frame;

  AnimatedSvgPageTurnView(@NonNull Context context) {
    super(context);
    setWillNotDraw(false);
    Log.i(TAG, "page-turn test created: drawMs=" + PAGE_DRAW_MS + " holdMs=" + PAGE_TURN_HOLD_MS);
    scheduleFrame();
  }

  void setPlaying(boolean value) {
    playing = value;
    if (playing) schedule(holding ? PAGE_TURN_HOLD_MS : 1000L / FPS);
    else {
      removeCallbacks(tick);
      scheduled = false;
    }
    invalidate();
  }

  void restart() {
    removeCallbacks(tick);
    scheduled = false;
    page = 0;
    frame = 0;
    holding = false;
    Log.i(TAG, "page-turn replay requested");
    invalidate();
    scheduleFrame();
  }

  void dispose() {
    disposed = true;
    removeCallbacks(tick);
    scheduled = false;
  }

  private void scheduleFrame() {
    schedule(1000L / FPS);
  }

  private void schedule(long delayMs) {
    if (!disposed && playing && !scheduled) {
      scheduled = true;
      postDelayed(tick, delayMs);
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
    final float scale = Math.min(getWidth() / VIEWBOX_WIDTH, getHeight() / VIEWBOX_HEIGHT);
    final float offsetX = (getWidth() - VIEWBOX_WIDTH * scale) / 2f;
    final float offsetY = (getHeight() - VIEWBOX_HEIGHT * scale) / 2f;
    canvas.save();
    canvas.translate(offsetX, offsetY);
    canvas.scale(scale, scale);
    canvas.drawRect(36f, 36f, 964f, 614f, borderPaint);
    canvas.drawText("PAGE " + (page + 1) + " / " + paths.length, 90f, 112f, labelPaint);
    if (holding) canvas.drawText("PAGE COMPLETE — TURNING IN 1 SEC", 390f, 112f, labelPaint);
    else canvas.drawText(Math.round(frame * 100f / PAGE_FRAMES) + "%", 840f, 112f, labelPaint);

    final PathMeasure measure = measures[page];
    final float distance = measure.getLength() * frame / (float) PAGE_FRAMES;
    visible.reset();
    if (distance > 0f) measure.getSegment(0f, distance, visible, true);
    canvas.drawPath(visible, inkPaint);
    if (distance > 0f) {
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

  private static Path parsePath(String data) {
    final String[] tokens = data.replaceAll("([A-Za-z])", " $1 ").trim().split("\\s+");
    final Path path = new Path();
    int index = 0;
    float x = 0f, y = 0f, controlX = 0f, controlY = 0f;
    while (index < tokens.length) {
      switch (tokens[index++]) {
        case "M": x = number(tokens, index++); y = number(tokens, index++); path.moveTo(x, y); break;
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
        default: throw new IllegalArgumentException("unsupported page-turn SVG command");
      }
    }
    return path;
  }

  private static float number(String[] tokens, int index) {
    return Float.parseFloat(tokens[index]);
  }
}
