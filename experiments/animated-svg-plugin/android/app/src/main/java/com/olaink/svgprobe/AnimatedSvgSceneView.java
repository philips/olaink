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
 * Deliberately small SVG-path scene renderer, not a general SVG/XML engine.
 * The path data matches animated-scene.svg; a View-delayed scheduler replaces
 * its SMIL stroke-dashoffset animation so no browser/WebView API is involved.
 */
final class AnimatedSvgSceneView extends View {
  private static final String TAG = "OlaInkSvgProbe";
  private static final float VIEWBOX_WIDTH = 1000f;
  private static final float VIEWBOX_HEIGHT = 650f;
  // Defaults for Nomad's e-ink refresh behavior; React props select a preset.
  private static final long DEFAULT_DURATION_MS = 6000L;
  private static final int DEFAULT_FRAMES_PER_SECOND = 10;
  private static final String SVG_PATH_DATA =
      "M90 445 C170 180 275 540 365 310 S535 180 610 390 S765 525 890 215";

  private final Paint paperPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint guidePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint inkPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint trailPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint tipPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Path sourcePath;
  private final Path visiblePath = new Path();
  private final Path committedPath = new Path();
  private final PathMeasure pathMeasure;
  private final float[] tipPosition = new float[2];
  private final Runnable frameTick = new Runnable() {
    @Override
    public void run() {
      tickScheduled = false;
      if (!playing || disposed) return;
      currentFrame = currentFrame >= frameCount ? 0 : currentFrame + 1;
      progress = currentFrame / (float) frameCount;
      if ("incremental".equals(technique)) {
        if (currentFrame == 0) committedPath.reset();
        else pathMeasure.getSegment(pathMeasure.getLength() * (currentFrame - 1) / (float) frameCount,
            pathMeasure.getLength() * progress, committedPath, true);
      }
      if (currentFrame % framesPerSecond == 0) {
        Log.i(TAG, "scheduled frame=" + currentFrame + "/" + frameCount
            + " progress=" + String.format(java.util.Locale.ROOT, "%.2f", progress)
            + " playing=" + playing);
      }
      invalidate();
      scheduleNextFrame();
    }
  };

  private boolean playing = true;
  private boolean disposed;
  private boolean tickScheduled;
  private long durationMs = DEFAULT_DURATION_MS;
  private int framesPerSecond = DEFAULT_FRAMES_PER_SECOND;
  private int frameCount = (int) (DEFAULT_DURATION_MS * DEFAULT_FRAMES_PER_SECOND / 1000L);
  private long frameIntervalMs = 1000L / DEFAULT_FRAMES_PER_SECOND;
  private float progress;
  private int currentFrame;
  private String technique = "prefix";

  AnimatedSvgSceneView(@NonNull Context context) {
    super(context);
    setWillNotDraw(false);

    paperPaint.setColor(0xfff7f4ed);
    guidePaint.setColor(0xffbcb7ae);
    guidePaint.setStyle(Paint.Style.STROKE);
    guidePaint.setStrokeWidth(3f);
    guidePaint.setStrokeCap(Paint.Cap.ROUND);

    inkPaint.setColor(0xff111111);
    inkPaint.setStyle(Paint.Style.STROKE);
    inkPaint.setStrokeWidth(18f);
    inkPaint.setStrokeCap(Paint.Cap.ROUND);
    inkPaint.setStrokeJoin(Paint.Join.ROUND);

    trailPaint.setColor(0xffaaa79f);
    trailPaint.setStyle(Paint.Style.STROKE);
    trailPaint.setStrokeWidth(16f);
    trailPaint.setStrokeCap(Paint.Cap.ROUND);
    trailPaint.setStrokeJoin(Paint.Join.ROUND);

    tipPaint.setColor(0xffcf3c25);
    labelPaint.setColor(0xff28251f);
    labelPaint.setTextSize(29f);
    labelPaint.setTypeface(android.graphics.Typeface.create(android.graphics.Typeface.MONOSPACE,
        android.graphics.Typeface.BOLD));

    sourcePath = parseProbeSvgPath(SVG_PATH_DATA);
    pathMeasure = new PathMeasure(sourcePath, false);
    Log.i(TAG, "scene created: pathLength=" + Math.round(pathMeasure.getLength())
        + " durationMs=" + durationMs + " frames=" + frameCount);

    // ValueAnimator is unusable here: Nomad's global animator scale is 0,
    // causing a nominal six-second animation to complete in milliseconds.
    // postDelayed is independent of that accessibility/developer setting.
    scheduleNextFrame();
  }

  /**
   * Tiny parser for exactly the source scene's absolute M, C, and S commands.
   * A real renderer should consume a reviewed typed scene, not grow this into
   * a general SVG/XML implementation.
   */
  private static Path parseProbeSvgPath(String pathData) {
    final String[] tokens = pathData.replaceAll("([A-Za-z])", " $1 ").trim().split("\\s+");
    final Path path = new Path();
    int index = 0;
    float x = 0f;
    float y = 0f;
    float lastControlX = 0f;
    float lastControlY = 0f;
    while (index < tokens.length) {
      final String command = tokens[index++];
      switch (command) {
        case "M":
          x = number(tokens, index++);
          y = number(tokens, index++);
          path.moveTo(x, y);
          break;
        case "C": {
          final float control1X = number(tokens, index++);
          final float control1Y = number(tokens, index++);
          final float control2X = number(tokens, index++);
          final float control2Y = number(tokens, index++);
          x = number(tokens, index++);
          y = number(tokens, index++);
          path.cubicTo(control1X, control1Y, control2X, control2Y, x, y);
          lastControlX = control2X;
          lastControlY = control2Y;
          break;
        }
        case "S": {
          final float control1X = 2f * x - lastControlX;
          final float control1Y = 2f * y - lastControlY;
          final float control2X = number(tokens, index++);
          final float control2Y = number(tokens, index++);
          x = number(tokens, index++);
          y = number(tokens, index++);
          path.cubicTo(control1X, control1Y, control2X, control2Y, x, y);
          lastControlX = control2X;
          lastControlY = control2Y;
          break;
        }
        default:
          throw new IllegalArgumentException("unsupported probe SVG command: " + command);
      }
    }
    return path;
  }

  private static float number(String[] tokens, int index) {
    if (index >= tokens.length) throw new IllegalArgumentException("truncated probe SVG path");
    return Float.parseFloat(tokens[index]);
  }

  private void scheduleNextFrame() {
    if (!disposed && playing && !tickScheduled) {
      tickScheduled = true;
      postDelayed(frameTick, frameIntervalMs);
    }
  }

  int getFramesPerSecond() {
    return framesPerSecond;
  }

  int getDurationMs() {
    return (int) durationMs;
  }

  void setTiming(int requestedDurationMs, int requestedFramesPerSecond) {
    durationMs = Math.max(1000L, Math.min(12000L, requestedDurationMs));
    framesPerSecond = Math.max(1, Math.min(20, requestedFramesPerSecond));
    frameCount = Math.max(1, (int) (durationMs * framesPerSecond / 1000L));
    frameIntervalMs = Math.max(1L, 1000L / framesPerSecond);
    Log.i(TAG, "timing preset durationMs=" + durationMs + " fps=" + framesPerSecond
        + " frames=" + frameCount);
    restart();
  }

  void setTechnique(String requestedTechnique) {
    if (!"prefix".equals(requestedTechnique) && !"incremental".equals(requestedTechnique)
        && !"cursor".equals(requestedTechnique)) {
      throw new IllegalArgumentException("unknown animation technique: " + requestedTechnique);
    }
    if (!technique.equals(requestedTechnique)) {
      technique = requestedTechnique;
      Log.i(TAG, "technique=" + technique);
      restart();
    }
  }

  void setPlaying(boolean shouldPlay) {
    playing = shouldPlay;
    Log.i(TAG, "setPlaying=" + shouldPlay + " frame=" + currentFrame
        + " tickScheduled=" + tickScheduled);
    if (shouldPlay) scheduleNextFrame();
    else {
      removeCallbacks(frameTick);
      tickScheduled = false;
    }
    invalidate();
  }

  void restart() {
    Log.i(TAG, "restart requested");
    removeCallbacks(frameTick);
    tickScheduled = false;
    currentFrame = 0;
    progress = 0f;
    committedPath.reset();
    invalidate();
    scheduleNextFrame();
  }

  void dispose() {
    Log.i(TAG, "scene disposed");
    disposed = true;
    removeCallbacks(frameTick);
    tickScheduled = false;
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
    final float x = (getWidth() - VIEWBOX_WIDTH * scale) / 2f;
    final float y = (getHeight() - VIEWBOX_HEIGHT * scale) / 2f;
    canvas.save();
    canvas.translate(x, y);
    canvas.scale(scale, scale);

    canvas.drawRect(36f, 36f, 964f, 614f, guidePaint);
    canvas.drawText(technique.toUpperCase(java.util.Locale.ROOT) + " / "
        + (durationMs / 1000L) + " SEC / " + framesPerSecond + " FPS", 90f, 115f, labelPaint);
    canvas.drawText(String.format(java.util.Locale.ROOT, "%3d%%", Math.round(progress * 100f)),
        820f, 115f, labelPaint);
    canvas.drawLine(90f, 510f, 910f, 510f, guidePaint);

    final float distance = pathMeasure.getLength() * progress;
    if ("incremental".equals(technique)) {
      // The path is appended once per tick and never cleared during a replay.
      canvas.drawPath(committedPath, inkPaint);
    } else if ("cursor".equals(technique)) {
      // Keep the full trace stable in light grey; only a short dark pen head
      // and its dot change, minimising the changed e-ink area per frame.
      canvas.drawPath(sourcePath, trailPaint);
      visiblePath.reset();
      final float tail = Math.max(0f, distance - 210f);
      if (distance > tail) pathMeasure.getSegment(tail, distance, visiblePath, true);
      canvas.drawPath(visiblePath, inkPaint);
    } else {
      visiblePath.reset();
      if (distance > 0f) pathMeasure.getSegment(0f, distance, visiblePath, true);
      canvas.drawPath(visiblePath, inkPaint);
    }
    if (progress > 0f) {
      pathMeasure.getPosTan(distance, tipPosition, null);
      canvas.drawCircle(tipPosition[0], tipPosition[1], 13f, tipPaint);
    }
    canvas.restore();
  }
}
