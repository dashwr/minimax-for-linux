#!/usr/bin/env python3
# mmx-linux: injetor uinput absoluto, só stdlib (fcntl.ioctl; Node não tem ioctl e python-evdev seria dep extra).
# protocolo (stdin/stdout, JSON por linha):
#   1a linha: {"w":W,"h":H}  -> cria dispositivo, espera registrar, imprime {"ready":true}
#   depois:   {"go":[ops...]} -> executa e imprime {"done":true}   |   {"abort":true} -> sai sem input
# ops: ["move",x,y] ["btn","left|right|middle",1|0] ["key",code,1|0] ["wheel",n] ["hwheel",n] ["sleep",ms]
# o processo nunca envia nada antes do "go"; o chamador só manda "go" depois de verificar a janela ativa.
import fcntl, json, os, struct, sys, time

EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
ABS_X, ABS_Y, REL_WHEEL, REL_HWHEEL = 0, 1, 8, 6
BTN = {'left': 0x110, 'right': 0x111, 'middle': 0x112}
UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT, UI_SET_ABSBIT = 0x40045564, 0x40045565, 0x40045566, 0x40045567
UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502

def out(o):
    sys.stdout.write(json.dumps(o) + '\n'); sys.stdout.flush()

def main():
    cfg = json.loads(sys.stdin.readline())
    W, H = int(cfg['w']), int(cfg['h'])
    fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
    for ev in (EV_SYN, EV_KEY, EV_REL, EV_ABS): fcntl.ioctl(fd, UI_SET_EVBIT, ev)
    for code in list(range(1, 249)) + list(BTN.values()): fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    for code in (REL_WHEEL, REL_HWHEEL): fcntl.ioctl(fd, UI_SET_RELBIT, code)
    for code in (ABS_X, ABS_Y): fcntl.ioctl(fd, UI_SET_ABSBIT, code)
    absmax = [0] * 64; absmax[ABS_X] = W - 1; absmax[ABS_Y] = H - 1
    dev = struct.pack('80sHHHHi64i64i64i64i', b'mmx-kwin-uinput', 0x06, 0x1, 0x1, 1, 0, *absmax, *([0] * 64), *([0] * 64), *([0] * 64))
    os.write(fd, dev)
    fcntl.ioctl(fd, UI_DEV_CREATE)
    def ev(t, c, v):
        s = time.time(); os.write(fd, struct.pack('llHHi', int(s), int((s % 1) * 1e6), t, c, v))
    def syn(): ev(EV_SYN, 0, 0)
    try:
        time.sleep(1.2)  # libinput/KWin precisam registrar o dispositivo
        out({'ready': True})
        msg = json.loads(sys.stdin.readline() or '{"abort":true}')
        if 'go' not in msg:
            out({'aborted': True}); return
        for op in msg['go']:
            k = op[0]
            if k == 'move':
                ev(EV_ABS, ABS_X, max(0, min(W - 1, int(op[1])))); ev(EV_ABS, ABS_Y, max(0, min(H - 1, int(op[2])))); syn(); time.sleep(0.15)
            elif k == 'btn': ev(EV_KEY, BTN[op[1]], int(op[2])); syn(); time.sleep(0.04)
            elif k == 'key': ev(EV_KEY, int(op[1]), int(op[2])); syn(); time.sleep(0.02)
            elif k == 'wheel': ev(EV_REL, REL_WHEEL, int(op[1])); syn(); time.sleep(0.05)
            elif k == 'hwheel': ev(EV_REL, REL_HWHEEL, int(op[1])); syn(); time.sleep(0.05)
            elif k == 'sleep': time.sleep(int(op[1]) / 1000)
        time.sleep(0.2)
        out({'done': True})
    finally:
        try: fcntl.ioctl(fd, UI_DEV_DESTROY)
        finally: os.close(fd)

if __name__ == '__main__':
    try: main()
    except Exception as e:
        out({'error': '%s: %s' % (type(e).__name__, e)}); sys.exit(1)
