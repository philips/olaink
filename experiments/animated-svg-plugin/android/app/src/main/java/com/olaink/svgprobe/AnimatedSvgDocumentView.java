package com.olaink.svgprobe;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PathMeasure;
import android.graphics.Typeface;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.util.Xml;
import android.view.View;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Plays the embedded-scene SVG fixtures shipped in assets/fixtures/. One
 * document = ordered pages; each page animates its strokes in writeOrder
 * (centreline reveal with contour swap), holds the finished page for one
 * second, then replaces it with the next page in the same viewport.
 */
final class AnimatedSvgDocumentView extends View {
  private static final String TAG = "OlaInkSvgProbe";
  private static final String PLUGIN_ID = "olainksvgprobe0001";
  private static final int FPS = 10;
  private static final long FRAME_MS = 1000L / FPS;
  private static final long PEN_LIFT_MS = 30L;
  private static final long PAGE_HOLD_MS = 1000L;
  private static final long STATIC_PAGE_MS = 1000L;

  /** One embedded-scene stroke: optional centreline preview + final contour. */
  private static final class Stroke {
    int writeOrder;
    int zOrder;
    Path centerline;
    PathMeasure centerlineMeasure;
    float centerlineLength;
    Paint linePaint;
    Path contour;
    Paint contourPaint;
    boolean fadeOnly;
    long startMs;
    long durationMs;
  }

  /** Static (non-animated) page decoration parsed from the SVG. */
  private static final class StaticShape {
    Path path;
    Paint paint;
    String text;
    float x;
    float y;
    float textSize;
    boolean isText;
  }

  /** A fully parsed page ready to draw and play. */
  private static final class Page {
    float viewWidth = 1404f;
    float viewHeight = 1872f;
    Bitmap background;
    Bitmap rasterInkOverlay;
    final List<Stroke> strokes = new ArrayList<>();
    final List<Integer> paintOrder = new ArrayList<>();
    final List<StaticShape> underlay = new ArrayList<>();
    long totalMs;
  }

  private final ExecutorService loader = Executors.newSingleThreadExecutor(runnable -> {
    final Thread thread = new Thread(runnable, "olaink-fixture-loader");
    thread.setDaemon(true);
    return thread;
  });
  private final Paint paperPaint = fill(0xffffffff);
  private final Paint errorPaint = text(0xffb3261e, 34f);
  private final Path scratch = new Path();

  @Nullable
  private List<String> pages;
  @Nullable
  private String pagesJson;
  private String documentTitle = "";
  private int pageIndex;
  private long generation;

  @Nullable
  private Page current;
  @Nullable
  private Page pendingNext;
  @Nullable
  private String loadError;
  private long pageStartUptime;
  private double pausedTimelineMs;
  private long holdStartWall;
  private float speed = 1f;
  private boolean holding;
  private boolean complete;
  private boolean playing = true;
  private boolean disposed;
  private boolean scheduled;

  private final Runnable tick = new Runnable() {
    @Override
    public void run() {
      scheduled = false;
      if (!playing || disposed || current == null) return;
      final long wallNow = SystemClock.uptimeMillis();
      final double timeline = timelineNowMs();
      final long pageMs = current.totalMs > 0 ? current.totalMs : STATIC_PAGE_MS;
      if (!holding && timeline >= pageMs) {
        holding = true;
        holdStartWall = wallNow;
        Log.i(TAG, "document=" + documentTitle + " page=" + (pageIndex + 1) + "/"
            + pages.size() + " complete; holding " + PAGE_HOLD_MS + "ms");
        if (pageIndex + 1 < pages.size()) requestLoad(pageIndex + 1, generation);
      }
      if (holding) {
        final boolean holdElapsed = wallNow - holdStartWall >= PAGE_HOLD_MS;
        if (pageIndex + 1 >= pages.size()) {
          if (holdElapsed) {
            complete = true;
            Log.i(TAG, "document=" + documentTitle + " complete");
            invalidate();
            return;
          }
        } else if (holdElapsed) {
          if (pendingNext != null) {
            final Page previous = current;
            current = pendingNext;
            pendingNext = null;
            pageIndex += 1;
            holding = false;
            loadError = null;
            pageStartUptime = SystemClock.uptimeMillis();
            recycleBackground(previous);
            Log.i(TAG, "document=" + documentTitle + " turning to page=" + (pageIndex + 1));
          } else if (loadError != null && wallNow - holdStartWall >= PAGE_HOLD_MS + 3000L) {
            complete = true;
            Log.i(TAG, "document=" + documentTitle
                + " stopped: next page failed to load");
            invalidate();
            return;
          }
          // While the next page is still parsing, keep the finished page up.
        }
      }
      invalidate();
      schedule(holding ? 100L : FRAME_MS);
    }
  };

  AnimatedSvgDocumentView(@NonNull Context context) {
    super(context);
    setWillNotDraw(false);
  }

  /** Receives the page file list for one fixture document; restarts playback. */
  void setPages(@Nullable String pagesJson, @NonNull String title) {
    final String nextJson = pagesJson == null ? null : pagesJson;
    final String nextTitle = title == null ? "" : title;
    if (pages != null && java.util.Objects.equals(this.pagesJson, nextJson)
        && documentTitle.equals(nextTitle)) return;
    this.pagesJson = nextJson;
    documentTitle = nextTitle;
    pages = null;
    if (nextJson != null) {
      try {
        final JSONArray array = new JSONArray(nextJson);
        final List<String> list = new ArrayList<>(array.length());
        for (int index = 0; index < array.length(); index++) list.add(array.getString(index));
        pages = list;
      } catch (Exception error) {
        Log.w(TAG, "bad pages JSON for " + documentTitle, error);
      }
    }
    restart();
  }

  @Nullable
  String getPagesJson() {
    return pagesJson;
  }

  @NonNull
  String getDocumentTitle() {
    return documentTitle;
  }

  void setPlaying(boolean value) {
    if (playing == value) return;
    playing = value;
    if (playing) {
      pageStartUptime = SystemClock.uptimeMillis() - (long) (pausedTimelineMs / speed);
      schedule(FRAME_MS);
    } else {
      pausedTimelineMs = timelineNowMs();
      removeCallbacks(tick);
      scheduled = false;
    }
    invalidate();
  }

  /** Scales the write timeline; the page-turn hold stays real time. */
  void setSpeed(float value) {
    final float next = value <= 0f ? 1f : value;
    if (next == speed) return;
    final double position = current == null || holding ? 0.0 : timelineNowMs();
    speed = next;
    if (playing && current != null) {
      pageStartUptime = SystemClock.uptimeMillis() - (long) (position / speed);
    }
    Log.i(TAG, "document=" + documentTitle + " playback speed=" + speed + "x");
    invalidate();
  }

  /** Current position on the (speed-scaled) page timeline in milliseconds. */
  private double timelineNowMs() {
    if (!playing) return pausedTimelineMs;
    return (SystemClock.uptimeMillis() - pageStartUptime) * (double) speed;
  }

  void restart() {
    removeCallbacks(tick);
    scheduled = false;
    generation += 1;
    pageIndex = 0;
    holding = false;
    complete = false;
    pendingNext = null;
    pausedTimelineMs = 0;
    holdStartWall = 0;
    current = null;
    loadError = null;
    pageStartUptime = SystemClock.uptimeMillis();
    Log.i(TAG, "document=" + documentTitle + " replay requested");
    if (pages != null && !pages.isEmpty()) requestLoad(0, generation);
    invalidate();
    if (playing) schedule(200L);
  }

  void dispose() {
    disposed = true;
    removeCallbacks(tick);
    scheduled = false;
    loader.shutdownNow();
    recycleBackground(current);
    recycleBackground(pendingNext);
    current = null;
    pendingNext = null;
  }

  private void requestLoad(final int index, final long expectedGeneration) {
    final String file = pages.get(index);
    loader.execute(() -> {
      Page parsed;
      try {
        parsed = parsePage("fixtures/" + file);
      } catch (Exception error) {
        Log.w(TAG, "failed to parse " + file, error);
        parsed = null;
        loadError = file + ": " + error;
      }
      if (disposed || generation != expectedGeneration) return;
      final Page parsedPage = parsed;
      post(() -> {
        if (disposed || generation != expectedGeneration) {
          recycleBackground(parsedPage);
          return;
        }
        if (parsedPage == null) {
          invalidate();
          return;
        }
        if (index == 0) {
          recycleBackground(current);
          current = parsedPage;
          pageIndex = 0;
          holding = false;
          pageStartUptime = SystemClock.uptimeMillis();
          Log.i(TAG, "document=" + documentTitle + " page=1/" + pages.size()
              + " strokes=" + current.strokes.size()
              + " durationMs=" + current.totalMs);
          invalidate();
          schedule(FRAME_MS);
        } else {
          recycleBackground(pendingNext);
          pendingNext = parsedPage;
        }
      });
    });
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
    if (pages == null || pages.isEmpty()) {
      canvas.drawText("No fixture document selected", 40f, 80f, errorPaint);
      return;
    }
    if (current == null) {
      if (loadError != null) {
        canvas.drawText("Load error: " + loadError, 40f, 80f, errorPaint);
        return;
      }
      canvas.drawText("Loading " + pages.get(pageIndex) + "…", 40f, 80f, errorPaint);
      schedule(200L);
      return;
    }
    if (loadError != null) canvas.drawText("Load error: " + loadError, 40f, 80f, errorPaint);

    final Page page = current;
    final float scale = Math.min(getWidth() / page.viewWidth, getHeight() / page.viewHeight);
    final float offsetX = (getWidth() - page.viewWidth * scale) / 2f;
    final float offsetY = (getHeight() - page.viewHeight * scale) / 2f;
    canvas.save();
    canvas.translate(offsetX, offsetY);
    canvas.scale(scale, scale);
    canvas.drawRect(0f, 0f, page.viewWidth, page.viewHeight, paperPaint);
    if (page.background != null) {
      canvas.drawBitmap(page.background, null,
          new android.graphics.RectF(0f, 0f, page.viewWidth, page.viewHeight), null);
    }
    for (StaticShape shape : page.underlay) {
      if (shape.isText) canvas.drawText(shape.text, shape.x, shape.y, shape.paint);
      else canvas.drawPath(shape.path, shape.paint);
    }

    final long elapsed = holding
        ? Long.MAX_VALUE
        : Math.round(timelineNowMs());
    int committed = 0;
    Stroke active = null;
    float activeFraction = 0f;
    for (Stroke stroke : page.strokes) {
      if (elapsed >= stroke.startMs + stroke.durationMs) committed += 1;
      else if (elapsed >= stroke.startMs) {
        active = stroke;
        activeFraction = (elapsed - stroke.startMs) / (float) stroke.durationMs;
        break;
      } else break;
    }
    for (int order = 0; order < page.paintOrder.size(); order++) {
      final Stroke stroke = page.strokes.get(page.paintOrder.get(order));
      if (page.paintOrder.get(order) < committed) {
        drawCommitted(canvas, stroke);
      }
    }
    if (active != null) drawActive(canvas, active, activeFraction);
    if (page.rasterInkOverlay != null) {
      canvas.drawBitmap(page.rasterInkOverlay, null,
          new android.graphics.RectF(0f, 0f, page.viewWidth, page.viewHeight), null);
    }
    canvas.restore();
  }

  private static void drawCommitted(Canvas canvas, Stroke stroke) {
    if (stroke.contour != null) canvas.drawPath(stroke.contour, stroke.contourPaint);
    else if (stroke.centerline != null) canvas.drawPath(stroke.centerline, stroke.linePaint);
  }

  private void drawActive(Canvas canvas, Stroke stroke, float fraction) {
    if (stroke.fadeOnly || stroke.centerline == null) {
      if (stroke.contour != null) {
        final int alpha = stroke.contourPaint.getAlpha();
        stroke.contourPaint.setAlpha(Math.round(alpha * Math.max(0.15f, fraction)));
        canvas.drawPath(stroke.contour, stroke.contourPaint);
        stroke.contourPaint.setAlpha(alpha);
      }
      return;
    }
    final float distance = stroke.centerlineLength * fraction;
    scratch.reset();
    if (stroke.centerlineMeasure.getSegment(0f, distance, scratch, true)) {
      canvas.drawPath(scratch, stroke.linePaint);
    }
  }

  // ---- parsing -----------------------------------------------------------

  private Page parsePage(String relativePath) throws Exception {
    // PluginHost extracts .snplg members under filesDir/plugins/<pluginID>/.
    final java.io.File file = new java.io.File(
        new java.io.File(getContext().getFilesDir(), "plugins" + java.io.File.separator + PLUGIN_ID),
        relativePath);
    final byte[] bytes = java.nio.file.Files.readAllBytes(file.toPath());

    final Page page = new Page();
    final java.util.Map<String, PathDef> pathsById = new java.util.HashMap<>();
    final List<PathDef> decorations = new ArrayList<>();
    final List<StaticShape> texts = new ArrayList<>();
    String metadataJson = null;

    final XmlPullParser parser = Xml.newPullParser();
    parser.setInput(new InputStreamReader(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8));
    StringBuilder textBuffer = null;
    float textX = 0f, textY = 0f, textSize = 24f;
    int textColor = 0xff111111;
    int event = parser.getEventType();
    while (event != XmlPullParser.END_DOCUMENT) {
      if (event == XmlPullParser.START_TAG) {
        final String name = local(parser.getName());
        if ("svg".equals(name)) {
          final float[] box = parseViewBox(attr(parser, "viewBox"));
          if (box != null) {
            page.viewWidth = box[2];
            page.viewHeight = box[3];
          }
        } else if ("metadata".equals(name)) {
          textBuffer = new StringBuilder();
        } else if ("path".equals(name)) {
          final PathDef def = PathDef.from(parser, page.viewWidth);
          if (def != null) {
            if (def.role != null && def.id != null) pathsById.put(def.id, def);
            else decorations.add(def);
          }
        } else if ("image".equals(name)) {
          final String href = attr(parser, "href");
          if (href != null && href.startsWith("data:image/png;base64,")) {
            final byte[] png = Base64.decode(href.substring(href.indexOf(',') + 1), Base64.DEFAULT);
            final BitmapFactory.Options options = new BitmapFactory.Options();
            options.inPreferredConfig = Bitmap.Config.RGB_565;
            final Bitmap bitmap = BitmapFactory.decodeByteArray(png, 0, png.length, options);
            if (bitmap != null) {
              // data-raster-ink-overlay paints ABOVE vector ink; the page
              // background sits beneath everything.
              final boolean isOverlay = "true".equals(attr(parser, "data-raster-ink-overlay"))
                  || page.background != null;
              if (isOverlay) {
                if (page.rasterInkOverlay != null) page.rasterInkOverlay.recycle();
                page.rasterInkOverlay = bitmap;
              } else {
                if (page.background != null) page.background.recycle();
                page.background = bitmap;
              }
            }
          }
        } else if ("rect".equals(name)) {
          addRect(page, parser);
        } else if ("text".equals(name)) {
          textBuffer = new StringBuilder();
          textX = number(attr(parser, "x"), 0f);
          textY = number(attr(parser, "y"), 0f);
          textSize = number(attr(parser, "font-size"), 24f);
          textColor = parseColor(attr(parser, "fill"), 0xff111111);
        }
      } else if (event == XmlPullParser.TEXT && textBuffer != null) {
        textBuffer.append(parser.getText());
      } else if (event == XmlPullParser.END_TAG) {
        final String name = local(parser.getName());
        if ("metadata".equals(name)) {
          metadataJson = textBuffer.toString().trim();
          textBuffer = null;
        } else if ("text".equals(name)) {
          final String value = textBuffer.toString().trim();
          textBuffer = null;
          if (!value.isEmpty() && textColor != 0x00000000) {
            final StaticShape shape = new StaticShape();
            shape.isText = true;
            shape.text = value;
            shape.x = textX;
            shape.y = textY;
            shape.paint = text(textColor, textSize);
            texts.add(shape);
          }
        }
      }
      event = parser.next();
    }

    // OCR text sits at the bottom; static vector decorations render above it.
    page.underlay.addAll(texts);
    for (PathDef def : decorations) {
      final Path path = def.toPath();
      if (path == null) continue;
      final StaticShape shape = new StaticShape();
      shape.path = path;
      if (def.fillColor != 0x00000000) {
        shape.paint = fill(def.fillColor);
      } else if (def.strokeColor != 0x00000000) {
        shape.paint = stroke(def.strokeColor, def.strokeWidth);
      } else continue;
      page.underlay.add(shape);
    }

    if (metadataJson != null) buildStrokes(page, metadataJson, pathsById);
    Log.i(TAG, "parse diagnostics: pathsById=" + pathsById.size()
        + " decorations=" + decorations.size()
        + " viewBox=" + page.viewWidth + "x" + page.viewHeight
        + " background=" + (page.background != null));
    for (Stroke stroke : page.strokes) page.totalMs += stroke.durationMs + PEN_LIFT_MS;
    if (!page.strokes.isEmpty()) page.totalMs -= PEN_LIFT_MS;

    final List<Stroke> byZ = new ArrayList<>(page.strokes);
    Collections.sort(byZ, (a, b) -> Integer.compare(a.zOrder, b.zOrder));
    for (Stroke stroke : byZ) page.paintOrder.add(page.strokes.indexOf(stroke));
    return page;
  }

  private void buildStrokes(Page page, String metadataJson,
      java.util.Map<String, PathDef> pathsById) throws Exception {
    final JSONObject scene = new JSONObject(metadataJson);
    final int version = scene.optInt("version", 1);
    if (version > 1) {
      Log.w(TAG, "scene version " + version + " is newer than supported 1; attempting anyway");
    }
    final JSONArray array = scene.getJSONArray("strokes");
    final List<Stroke> strokes = new ArrayList<>();
    for (int index = 0; index < array.length(); index++) {
      final JSONObject entry = array.getJSONObject(index);
      final Stroke stroke = new Stroke();
      final PathDef line = pathsById.get(entry.optString("centerline", null));
      final PathDef fillDef = pathsById.get(entry.optString("contour", null));
      if (line != null) {
        stroke.centerline = line.toPath();
        if (stroke.centerline != null) {
          stroke.centerlineMeasure = new PathMeasure(stroke.centerline, false);
          stroke.centerlineLength = stroke.centerlineMeasure.getLength();
          stroke.linePaint = stroke(line.strokeColor, line.strokeWidth);
        }
      }
      if (fillDef != null) {
        stroke.contour = fillDef.toPath();
        if (stroke.contour != null) {
          // Erase strokes cover ink: the exporter marks them
          // oi:role="erase-cover" (contour carries the page-coloured stroke,
          // not a fill). Older files express the same thing implicitly via
          // fill="none" + stroke; stroke them either way — filling one
          // paints a giant blob.
          final boolean eraseCover = "erase-cover".equals(fillDef.role)
              || (fillDef.fillColor == 0x00000000 && fillDef.strokeColor != 0x00000000);
          if (eraseCover) {
            stroke.contourPaint = stroke(fillDef.strokeColor, fillDef.strokeWidth);
          } else {
            stroke.contourPaint = fill(fillDef.fillColor);
          }
        }
      }
      stroke.fadeOnly = stroke.centerline == null || stroke.centerlineLength <= 0f;
      stroke.zOrder = entry.optInt("zOrder", index);
      stroke.writeOrder = entry.optInt("writeOrder", index);
      strokes.add(stroke);
    }
    Collections.sort(strokes, Comparator.comparingInt(s -> s.writeOrder));
    long cursor = 0L;
    for (Stroke stroke : strokes) {
      final long duration = Math.max(80L, Math.min(1200L,
          Math.round(stroke.centerlineLength / 250d * 1000d)));
      stroke.startMs = cursor;
      stroke.durationMs = duration;
      cursor += duration + PEN_LIFT_MS;
    }
    page.strokes.addAll(strokes);
  }

  private void addRect(Page page, XmlPullParser parser) {
    final String fill = attr(parser, "fill");
    if (fill == null || fill.startsWith("url(")) return;
    final float x = number(attr(parser, "x"), 0f);
    final float y = number(attr(parser, "y"), 0f);
    final float width = number(attr(parser, "width"), -1f);
    final float height = number(attr(parser, "height"), -1f);
    if (width <= 0f || height <= 0f) return;
    final int color = parseColor(fill, 0x00000000);
    if (color == 0x00000000) return;
    final Path path = new Path();
    path.moveTo(x, y);
    path.lineTo(x + width, y);
    path.lineTo(x + width, y + height);
    path.lineTo(x, y + height);
    path.close();
    final StaticShape shape = new StaticShape();
    shape.path = path;
    shape.paint = fill(color);
    page.underlay.add(shape);
  }

  private static void recycleBackground(@Nullable Page page) {
    if (page == null) return;
    if (page.background != null) page.background.recycle();
    if (page.rasterInkOverlay != null) page.rasterInkOverlay.recycle();
  }

  private void schedule(long delayMs) {
    if (!disposed && playing && !scheduled) {
      scheduled = true;
      postDelayed(tick, delayMs);
    }
  }

  private static String local(String name) {
    final int colon = name.indexOf(':');
    return colon >= 0 ? name.substring(colon + 1) : name;
  }

  private static String attr(XmlPullParser parser, String localName) {
    for (int index = 0; index < parser.getAttributeCount(); index++) {
      final String name = parser.getAttributeName(index);
      if (name.equals(localName) || local(name).equals(localName)) return parser.getAttributeValue(index);
    }
    return null;
  }

  private static float[] parseViewBox(String value) {
    if (value == null) return null;
    final String[] parts = value.trim().split("[\\s,]+");
    if (parts.length != 4) return null;
    try {
      return new float[] {
          Float.parseFloat(parts[0]), Float.parseFloat(parts[1]),
          Float.parseFloat(parts[2]), Float.parseFloat(parts[3])};
    } catch (NumberFormatException error) {
      return null;
    }
  }

  private static float number(String value, float fallback) {
    if (value == null) return fallback;
    try {
      return Float.parseFloat(value);
    } catch (NumberFormatException error) {
      return fallback;
    }
  }

  private static int parseColor(String value, int fallback) {
    if (value == null || "none".equals(value)) return 0x00000000;
    value = value.trim();
    if ("transparent".equals(value)) return 0x00000000;
    if (value.startsWith("rgb(") && value.endsWith(")")) {
      final String[] parts = value.substring(4, value.length() - 1).split(",");
      try {
        return Color.rgb(Integer.parseInt(parts[0].trim()),
            Integer.parseInt(parts[1].trim()), Integer.parseInt(parts[2].trim()));
      } catch (Exception error) {
        return fallback;
      }
    }
    if (value.startsWith("#")) {
      try {
        return Color.parseColor(value);
      } catch (IllegalArgumentException error) {
        return fallback;
      }
    }
    if ("white".equals(value)) return 0xffffffff;
    if ("black".equals(value)) return 0xff000000;
    return fallback;
  }

  private static Paint fill(int color) {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(color == 0 ? 0xff000000 : color);
    paint.setStyle(Paint.Style.FILL);
    return paint;
  }

  private static Paint stroke(int color, float width) {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(color == 0 ? 0xff000000 : color);
    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(width <= 0f ? 2f : width);
    paint.setStrokeCap(Paint.Cap.ROUND);
    paint.setStrokeJoin(Paint.Join.ROUND);
    return paint;
  }

  private static Paint text(int color, float size) {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(color);
    paint.setTextSize(size <= 0f ? 24f : size);
    paint.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL));
    return paint;
  }

  /** Raw SVG <path> attributes before stroke assembly. */
  private static final class PathDef {
    String id;
    String role;
    String data;
    int fillColor;
    int strokeColor;
    float strokeWidth = 2f;

    static PathDef from(XmlPullParser parser, float viewWidth) {
      final String data = attr(parser, "d");
      if (data == null) return null;
      final PathDef def = new PathDef();
      def.id = attr(parser, "id");
      def.role = attr(parser, "role");
      def.data = data;
      def.fillColor = parseColor(attr(parser, "fill"), 0x00000000);
      def.strokeColor = parseColor(attr(parser, "stroke"), 0x00000000);
      def.strokeWidth = number(attr(parser, "stroke-width"), 2f);
      return def;
    }

    Path toPath() {
      try {
        return parseTrack(data);
      } catch (RuntimeException error) {
        Log.w(TAG, "unsupported path data in " + id, error);
        return null;
      }
    }
  }

  /** Fixture paths use absolute M/L/Z only (verified across all fixtures). */
  private static Path parseTrack(String data) {
    final String[] tokens = data.trim().replaceAll("([A-Za-z])", " $1 ").trim().split("[\\s,]+");
    final Path path = new Path();
    char command = 0;
    boolean firstMove = true;
    int index = 0;
    while (index < tokens.length) {
      final String token = tokens[index];
      if (token.length() == 1 && "MLZ".indexOf(token.charAt(0)) >= 0) {
        command = token.charAt(0);
        index += 1;
        if (command == 'Z') {
          path.close();
          continue;
        }
        if (command == 'M') firstMove = true;
      }
      if (command == 0) throw new IllegalArgumentException("path must start with M/L/Z");
      final float x = Float.parseFloat(tokens[index]);
      final float y = Float.parseFloat(tokens[index + 1]);
      index += 2;
      if (command == 'M' && firstMove) {
        path.moveTo(x, y);
        firstMove = false;
      } else {
        path.lineTo(x, y);
      }
    }
    return path;
  }
}
