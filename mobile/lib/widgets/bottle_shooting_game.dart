import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// A self-contained bottle-shooting mini game used while a generation request
/// is running. It does not own, cancel, or otherwise interfere with that request.
class BottleShootingGameOverlay extends StatefulWidget {
  const BottleShootingGameOverlay({
    super.key,
    required this.statusText,
  });

  final String statusText;

  @override
  State<BottleShootingGameOverlay> createState() =>
      _BottleShootingGameOverlayState();
}

class _BottleShootingGameOverlayState extends State<BottleShootingGameOverlay>
    with SingleTickerProviderStateMixin {
  static const Color _mint = Color(0xFF9BE6B4);
  static const Color _deepGreen = Color(0xFF14251B);

  late final AnimationController _ticker;
  final Stopwatch _clock = Stopwatch();
  final List<_Bottle> _bottles = <_Bottle>[];
  final List<_Particle> _particles = <_Particle>[];

  Size _playSize = Size.zero;
  Offset? _aimPoint;
  _Projectile? _projectile;
  int _score = 0;
  int _level = 1;
  int _shots = 0;
  double _lastTick = 0;
  bool _roundResetPending = false;

  @override
  void initState() {
    super.initState();
    _ticker = AnimationController(
      vsync: this,
      duration: const Duration(days: 1),
    )..addListener(_step);
    _ticker.repeat();
    _clock.start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    _clock.stop();
    super.dispose();
  }

  void _ensureTargets(Size size) {
    if (size == _playSize && _bottles.isNotEmpty) return;
    _playSize = size;
    _spawnWave();
  }

  void _spawnWave() {
    if (_playSize.isEmpty) return;
    _bottles
      ..clear()
      ..addAll(List<_Bottle>.generate(6 + math.min(_level - 1, 3), (index) {
        final count = 6 + math.min(_level - 1, 3).toInt();
        final gap = math.min(58.0, (_playSize.width - 48) / count).toDouble();
        final total = gap * (count - 1);
        final left = (_playSize.width - total) / 2;
        return _Bottle(
          x: left + index * gap,
          baseY: _playSize.height * 0.68,
          colorIndex: index % 4,
        );
      }));
    _particles.clear();
    _projectile = null;
    _aimPoint = null;
    _roundResetPending = false;
  }

  void _onSizeChanged(Size size) {
    if (size.width <= 0 || size.height <= 0) return;
    _ensureTargets(size);
  }

  void _onPanStart(DragStartDetails details) {
    setState(() => _aimPoint = details.localPosition);
  }

  void _onPanUpdate(DragUpdateDetails details) {
    setState(() => _aimPoint = details.localPosition);
  }

  void _onPanEnd(DragEndDetails details) {
    final target = _aimPoint;
    if (target == null || _projectile != null || _playSize.isEmpty) return;

    final origin = Offset(_playSize.width / 2, _playSize.height - 34);
    final delta = target - origin;
    if (delta.dy > -18 || delta.distance < 18) {
      setState(() => _aimPoint = null);
      return;
    }

    final direction = delta / delta.distance;
    setState(() {
      _shots++;
      _projectile = _Projectile(
        x: origin.dx,
        y: origin.dy,
        vx: direction.dx * 920,
        vy: direction.dy * 920,
      );
      _aimPoint = null;
    });
    HapticFeedback.selectionClick();
  }

  void _step() {
    if (!mounted || _playSize.isEmpty) return;
    final now = _clock.elapsedMicroseconds / 1000000.0;
    final dt = (now - _lastTick).clamp(0.0, 0.032);
    _lastTick = now;
    if (dt <= 0) return;

    bool changed = false;
    final shot = _projectile;
    if (shot != null) {
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      shot.vy += 760 * dt;
      shot.life += dt;
      if (shot.x < -20 ||
          shot.x > _playSize.width + 20 ||
          shot.y < -20 ||
          shot.y > _playSize.height + 20 ||
          shot.life > 1.7) {
        _projectile = null;
      } else {
        for (final bottle in _bottles) {
          if (bottle.toppled) continue;
          final dx = shot.x - bottle.x;
          final dy = shot.y - (bottle.baseY - 34);
          if (dx * dx + dy * dy < 27 * 27) {
            bottle.vx = (shot.vx * 0.22).clamp(-260.0, 260.0).toDouble();
            bottle.vy = -105;
            bottle.angularVelocity = shot.vx >= 0 ? 5.8 : -5.8;
            bottle.hit = true;
            _score += 10;
            _projectile = null;
            _burst(bottle.x, bottle.baseY - 35);
            HapticFeedback.lightImpact();
            changed = true;

            // A close bottle gets nudged as the row is knocked over.
            for (final neighbour in _bottles) {
              if (identical(neighbour, bottle) || neighbour.toppled) continue;
              if ((neighbour.x - bottle.x).abs() < 55) {
                neighbour.vx += bottle.vx * 0.24;
                neighbour.angularVelocity += bottle.vx >= 0 ? 1.2 : -1.2;
              }
            }
            break;
          }
        }
      }
      changed = true;
    }

    for (final bottle in _bottles) {
      if (bottle.toppled) continue;
      bottle.x += bottle.vx * dt;
      bottle.baseY += bottle.vy * dt;
      bottle.vy += 900 * dt;
      bottle.angle += bottle.angularVelocity * dt;
      bottle.vx *= math.pow(0.985, dt * 60).toDouble();
      bottle.angularVelocity *= math.pow(0.992, dt * 60).toDouble();

      final floor = _playSize.height * 0.68;
      if (bottle.baseY > floor) {
        bottle.baseY = floor;
        if (bottle.vy > 0) bottle.vy = -bottle.vy * 0.16;
        if (bottle.vy.abs() < 18) bottle.vy = 0;
      }
      if (bottle.angle.abs() > 1.25) {
        bottle.toppled = true;
        bottle.angularVelocity = 0;
        bottle.vx *= 0.25;
        _burst(bottle.x, bottle.baseY - 30);
      }
      changed = true;
    }

    for (final particle in _particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += 520 * dt;
      particle.life -= dt;
    }
    _particles.removeWhere((particle) => particle.life <= 0);

    if (_bottles.isNotEmpty &&
        _bottles.every((bottle) => bottle.toppled) &&
        !_roundResetPending) {
      _roundResetPending = true;
      Future<void>.delayed(const Duration(milliseconds: 900), () {
        if (!mounted) return;
        setState(() {
          _level++;
          _spawnWave();
        });
      });
    }

    if (changed || _particles.isNotEmpty) {
      // The ticker drives the painter directly; setState is only needed for
      // score and round changes, avoiding a rebuild on every animation frame.
    }
  }

  void _burst(double x, double y) {
    final random = math.Random((_score + _shots * 31 + x.round()).abs());
    for (var i = 0; i < 7; i++) {
      final angle = (math.pi * 2 * i / 7) + random.nextDouble() * 0.3;
      final speed = 65 + random.nextDouble() * 145;
      _particles.add(_Particle(
        x: x,
        y: y,
        vx: math.cos(angle) * speed,
        vy: math.sin(angle) * speed - 65,
        life: 0.45 + random.nextDouble() * 0.35,
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xF20B120E),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 16),
          child: Column(
            children: [
              const Text(
                'FACHS ARCADE',
                style: TextStyle(
                  color: _mint,
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 3,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Bottle Shooter',
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 29,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                widget.statusText,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Color(0xFFD5E2D8), fontSize: 13),
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  _stat('SCORE', '$_score'),
                  const SizedBox(width: 8),
                  _stat('LEVEL', '$_level'),
                  const SizedBox(width: 8),
                  _stat('SHOTS', '$_shots'),
                ],
              ),
              const SizedBox(height: 12),
              Expanded(
                child: LayoutBuilder(
                  builder: (context, constraints) {
                    final size = Size(
                      constraints.maxWidth,
                      constraints.maxHeight,
                    );
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (mounted) _onSizeChanged(size);
                    });
                    return ClipRRect(
                      borderRadius: BorderRadius.circular(22),
                      child: GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onPanStart: _onPanStart,
                        onPanUpdate: _onPanUpdate,
                        onPanEnd: _onPanEnd,
                        child: AnimatedBuilder(
                          animation: _ticker,
                          builder: (context, _) => CustomPaint(
                            size: size,
                            painter: _BottleRangePainter(
                              bottles: _bottles,
                              particles: _particles,
                              projectile: _projectile,
                              aimPoint: _aimPoint,
                              score: _score,
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'DRAG TO AIM  •  RELEASE TO SHOOT',
                style: TextStyle(
                  color: _mint,
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 1.4,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Knock every bottle down to reach the next level.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xFF9BAAA0), fontSize: 11),
              ),
              const SizedBox(height: 8),
              const Text(
                'Your workout or meal plan is still being prepared.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Color(0xFF9BAAA0), fontSize: 10),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _stat(String label, String value) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 9),
        decoration: BoxDecoration(
          color: const Color(0xFF1D3024),
          borderRadius: BorderRadius.circular(13),
          border: Border.all(color: const Color(0xFF385541)),
        ),
        child: Column(
          children: [
            Text(
              label,
              style: const TextStyle(
                color: Color(0xFF9BAAA0),
                fontSize: 9,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.1,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              value,
              style: const TextStyle(
                color: _mint,
                fontSize: 18,
                fontWeight: FontWeight.w900,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Bottle {
  _Bottle({
    required this.x,
    required this.baseY,
    required this.colorIndex,
  });

  double x;
  double baseY;
  final int colorIndex;
  double vx = 0;
  double vy = 0;
  double angle = 0;
  double angularVelocity = 0;
  bool hit = false;
  bool toppled = false;
}

class _Projectile {
  _Projectile({
    required this.x,
    required this.y,
    required this.vx,
    required this.vy,
  });

  double x;
  double y;
  double vx;
  double vy;
  double life = 0;
}

class _Particle {
  _Particle({
    required this.x,
    required this.y,
    required this.vx,
    required this.vy,
    required this.life,
  });

  double x;
  double y;
  double vx;
  double vy;
  double life;
}

class _BottleRangePainter extends CustomPainter {
  _BottleRangePainter({
    required this.bottles,
    required this.particles,
    required this.projectile,
    required this.aimPoint,
    required this.score,
  });

  final List<_Bottle> bottles;
  final List<_Particle> particles;
  final _Projectile? projectile;
  final Offset? aimPoint;
  final int score;

  static const List<Color> _glassColors = [
    Color(0xFF7CCB91),
    Color(0xFF78B9D4),
    Color(0xFFC7A66C),
    Color(0xFFB38BCB),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    final background = Paint()
      ..shader = const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        colors: [Color(0xFF1C3828), Color(0xFF101B14)],
      ).createShader(Offset.zero & size);
    canvas.drawRect(Offset.zero & size, background);

    final glow = Paint()
      ..shader = RadialGradient(
        colors: [const Color(0xFF4F9B67).withOpacity(0.2), Colors.transparent],
      ).createShader(Rect.fromCircle(
        center: Offset(size.width / 2, size.height * 0.48),
        radius: size.width * 0.65,
      ));
    canvas.drawRect(Offset.zero & size, glow);

    final floorY = size.height * 0.68;
    final floor = Paint()..color = const Color(0xFF314B39);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(12, floorY, size.width - 24, 13),
        const Radius.circular(7),
      ),
      floor,
    );
    canvas.drawLine(
      Offset(18, floorY + 2),
      Offset(size.width - 18, floorY + 2),
      Paint()
        ..color = const Color(0xFF8DBB91).withOpacity(0.5)
        ..strokeWidth = 1.2,
    );

    for (final bottle in bottles) {
      if (!bottle.toppled) _drawBottle(canvas, bottle);
    }

    for (final particle in particles) {
      final alpha = particle.life.clamp(0.0, 1.0).toDouble();
      canvas.drawCircle(
        Offset(particle.x, particle.y),
        2.5 + alpha * 2,
        Paint()..color = const Color(0xFFB8F4C6).withOpacity(alpha),
      );
    }

    final cannon = Offset(size.width / 2, size.height - 34);
    canvas.drawCircle(cannon, 17, Paint()..color = const Color(0xFF385A43));
    canvas.drawCircle(
      cannon,
      10,
      Paint()..color = const Color(0xFF9BE6B4),
    );
    canvas.drawCircle(
      cannon,
      4,
      Paint()..color = const Color(0xFF173321),
    );

    if (aimPoint != null && projectile == null) {
      final delta = aimPoint! - cannon;
      if (delta.dy < 0) {
        final direction = delta / math.max(1.0, delta.distance).toDouble();
        final end = cannon + direction * 150;
        final guide = Paint()
          ..color = const Color(0xFFB7F2C6).withOpacity(0.75)
          ..strokeWidth = 2
          ..strokeCap = StrokeCap.round;
        for (var i = 0; i < 6; i++) {
          final start = Offset.lerp(cannon, end, i / 7)!;
          final finish = Offset.lerp(cannon, end, (i + 0.45) / 7)!;
          canvas.drawLine(start, finish, guide);
        }
        canvas.drawCircle(
          aimPoint!,
          8,
          Paint()
            ..color = const Color(0xFFB7F2C6).withOpacity(0.8)
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.5,
        );
      }
    }

    if (projectile != null) {
      canvas.drawCircle(
        Offset(projectile!.x, projectile!.y),
        7,
        Paint()
          ..color = const Color(0xFFFFE7A3)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 5),
      );
      canvas.drawCircle(
        Offset(projectile!.x, projectile!.y),
        4,
        Paint()..color = Colors.white,
      );
    }

    final hint = TextPainter(
      text: const TextSpan(
        text: 'HIT THE BOTTLES',
        style: TextStyle(
          color: Color(0xFFB5CDB9),
          fontSize: 10,
          fontWeight: FontWeight.w800,
          letterSpacing: 2,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    hint.paint(canvas, Offset((size.width - hint.width) / 2, 18));
  }

  void _drawBottle(Canvas canvas, _Bottle bottle) {
    canvas.save();
    canvas.translate(bottle.x, bottle.baseY);
    canvas.rotate(bottle.angle);

    final glass = _glassColors[bottle.colorIndex];
    final body = Path()
      ..moveTo(-12, -5)
      ..lineTo(-13, -39)
      ..quadraticBezierTo(-13, -45, -8, -47)
      ..lineTo(-6, -51)
      ..lineTo(-6, -61)
      ..lineTo(6, -61)
      ..lineTo(6, -51)
      ..lineTo(8, -47)
      ..quadraticBezierTo(13, -45, 13, -39)
      ..lineTo(12, -5)
      ..quadraticBezierTo(11, 0, 6, 0)
      ..lineTo(-6, 0)
      ..quadraticBezierTo(-11, 0, -12, -5)
      ..close();

    canvas.drawPath(
      body,
      Paint()
        ..color = glass.withOpacity(0.88)
        ..style = PaintingStyle.fill,
    );
    canvas.drawPath(
      body,
      Paint()
        ..color = const Color(0xFFD9F6E0)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.6,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        const Rect.fromLTWH(-5, -64, 10, 5),
        const Radius.circular(2),
      ),
      Paint()..color = const Color(0xFFD8E8D8),
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        const Rect.fromLTWH(-8, -31, 16, 12),
        const Radius.circular(3),
      ),
      Paint()..color = const Color(0xFFE9F3D8).withOpacity(0.9),
    );
    canvas.drawLine(
      const Offset(-7, -38),
      const Offset(-7, -10),
      Paint()
        ..color = Colors.white.withOpacity(0.35)
        ..strokeWidth = 2,
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _BottleRangePainter oldDelegate) => true;
}
