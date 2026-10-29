"""Bake photographed livery artwork and a wheelbase-anchored panel map.

Run from this directory with:
  uv run --with opencv-python --with numpy --with trimesh python utils/process_livery.py

Side cameras are calibrated from the two visible wheel centres. corpus1 is a
single shell, so panel membership is stored as explicit spatial intervals in
the same model coordinates used by the runtime shader.
"""
from pathlib import Path
import json
import argparse
import cv2
import numpy as np
import trimesh

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'assets' / 'livery'
OUT = SRC / 'processed'
OUT.mkdir(parents=True, exist_ok=True)
MODEL = ROOT / 'assets' / 'taycan_f.glb'
WHEELBASE_M = 2.914
WHEEL_CENTRES = {'front': 1.486, 'rear': -1.428}

# Body surface segmentation. Axle centres are hard geometric datums; the
# unexposed panel seams are spatial estimates because the GLB has no seam IDs.
PARTS = {
 'front_bumper': {'z': [1.93, 2.48], 'y': [.22, .87], 'surfaces': 'front-facing shell and side wrap'},
 'front_fender': {'z': [.76, 1.93], 'y': [.30, .92], 'surfaces': 'outer flank; wheel-arch surface'},
 'front_door': {'z': [-.12, .76], 'y': [.34, .99], 'surfaces': 'outer flank'},
 'rear_door': {'z': [-.86, -.12], 'y': [.34, .98], 'surfaces': 'outer flank'},
 'rear_fender': {'z': [-1.93, -.86], 'y': [.30, .91], 'surfaces': 'outer flank; wheel-arch surface'},
 'rear_bumper': {'z': [-2.49, -1.93], 'y': [.22, .88], 'surfaces': 'rear-facing shell and side wrap'},
 'hood': {'z': [1.39, 2.48], 'y': [.76, 1.10], 'surfaces': 'upper forward shell'},
 'roof': {'z': [-1.33, .91], 'y': [1.08, 1.41], 'surfaces': 'upper shell'},
 'boot_tailgate': {'z': [-2.44, -1.27], 'y': [.79, 1.08], 'surfaces': 'upper rear shell'},
 'side_skirts': {'z': [-1.78, 1.78], 'y': [.20, .40], 'surfaces': 'lower lateral shell'},
 'mirrors': {'mesh_material': 'MIRROR', 'surfaces': 'separate mesh, not corpus1'}
}

def source_car_mask(name, im):
    h, w = im.shape[:2]
    rects = {'left': (3, 4, w-8, h-20), 'right': (3, 4, w-8, h-35),
             'hood': (18, 10, w-36, h-110), 'rear': (10, 8, w-20, h-120)}
    mask = np.zeros((h,w), np.uint8); bg = np.zeros((1,65),np.float64); fg = np.zeros((1,65),np.float64)
    cv2.grabCut(im, mask, rects[name], bg, fg, 5, cv2.GC_INIT_WITH_RECT)
    out = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(out, 8)
    if n > 1: out = np.where(labels == 1 + np.argmax(stats[1:,cv2.CC_STAT_AREA]),255,0).astype(np.uint8)
    return cv2.morphologyEx(out, cv2.MORPH_CLOSE, np.ones((7,7),np.uint8))

def paint_mask(name, image, carmask):
    h,w = image.shape[:2]
    if name == 'hood':
        # The front photo contains two real surfaces separated by the
        # horizontal hood-to-bumper crease. Keep its original pixel grid so
        # both registered bands share one camera datum and no resampling can
        # change the artwork proportions.
        crease_y = 494
        alpha = np.zeros((h,w), np.uint8)
        def front_poly(points, value=255):
            pts=np.array([[tuple(map(int,p)) for p in points]],np.int32)
            cv2.fillPoly(alpha,pts,value)
        # Painted hood: exclude the windshield/studio above its rear edge.
        front_poly([(0,312),(80,304),(158,289),(215,271),(257,264),
                    (1090,264),(1150,272),(1215,285),(w-1,309),
                    (w-1,crease_y),(0,crease_y)])
        # Painted bumper and printed grille area below the same crease.
        front_poly([(0,crease_y),(w-1,crease_y),(w-1,748),(1312,782),
                    (1244,803),(95,803),(25,780),(0,744)])
        # Preserve the model's own headlamps; these polygons cover the lamp
        # glass and its photographed bezel, not the surrounding printed paint.
        front_poly([(96,393),(125,382),(186,375),(249,379),(316,392),
                    (351,419),(372,470),(365,486),(117,486),(91,454)],0)
        front_poly([(w-1-96,393),(w-1-125,382),(w-1-186,375),
                    (w-1-249,379),(w-1-316,392),(w-1-351,419),
                    (w-1-372,470),(w-1-365,486),(w-1-117,486),
                    (w-1-91,454)],0)
        # The plate and its complete mounting surround are not client artwork.
        front_poly([(500,533),(870,533),(870,667),(500,667)],0)
        alpha=cv2.GaussianBlur(alpha,(3,3),.45)
        # Keep the plate/mount cutout exact even after edge antialiasing.
        alpha[533:668,500:871]=0
        rgba=cv2.cvtColor(image,cv2.COLOR_BGR2BGRA); rgba[:,:,3]=alpha
        return rgba
    # Side masks are spatial masks of the photographed body. Every RGB value
    # inside the body survives, including printed white and the pale-blue ramp.
    if name in ('left','right'):
        def poly_mask(points):
            pts = np.array([[(round(x*(w-1)),round(y*(h-1))) for x,y in points]],np.int32)
            m = np.zeros((h,w),np.uint8); cv2.fillPoly(m,pts,255); return m
        # Clamp to the photographed car silhouette. Side glass is part of the
        # show-car wrap surface, so the envelope spans from the roof/glazing
        # edge through the rocker line; only wheels and plate are cut out.
        outlines = {
          'left': [(0,.31),(.055,.30),(.10,.26),(.14,.18),(.22,.10),(.32,.04),(.42,.005),(.53,.005),(.62,.025),(.69,.08),(.75,.17),(.79,.27),(.84,.30),(.94,.32),(1,.39),(1,.59),(.98,.67),(.96,.73),(.94,.83),(.92,.86),(.86,.865),(.76,.86),(.72,.84),(.61,.86),(.30,.86),(.27,.84),(.26,.72),(.235,.66),(.21,.64),(.19,.65),(.17,.71),(.17,.86),(.09,.86),(.065,.84),(.05,.80),(.03,.75),(0,.70)],
          'right': [(0,.39),(.055,.35),(.11,.32),(.18,.30),(.25,.29),(.30,.26),(.34,.20),(.38,.14),(.43,.08),(.48,.035),(.56,.025),(.64,.035),(.71,.09),(.76,.17),(.79,.25),(.84,.30),(.91,.33),(.97,.37),(1,.40),(1,.61),(.99,.68),(.975,.74),(.96,.80),(.94,.825),(.89,.83),(.84,.84),(.80,.83),(.78,.81),(.77,.76),(.76,.71),(.74,.67),(.71,.65),(.68,.66),(.66,.71),(.65,.79),(.64,.84),(.54,.84),(.50,.83),(.45,.84),(.32,.835),(.27,.825),(.25,.80),(.245,.74),(.23,.70),(.21,.68),(.19,.68),(.17,.72),(.16,.80),(.15,.835),(.07,.82),(.05,.78),(.03,.71),(0,.67)]
        }[name]
        # The hand-traced envelope is the body-region mask. Do not intersect
        # it with GrabCut: GrabCut treats thin, pale-blue print on white paint
        # as background and removes the front-fender line-work.
        keep = poly_mask(outlines)
        # Exclude the full visible tyre and wheel disc, with an approximately
        # 12 px margin. Rectangles intentionally cover the photographed tyre
        # shoulder and all spokes; this alpha is only for artwork projection.
        # Pixel bounds below enclose the ellipse after its safety margin.
        wheel_masks = ([(360,353,175,145),(1375,362,180,145)] if name=='left'
                       else [(345,445,200,145),(1530,442,160,145)])
        for x,y,rx,ry in wheel_masks:
            cv2.ellipse(keep,(x,y),(rx,ry),0,0,360,0,-1)
        # The right photo's clean white nose ends just before the front arch;
        # leave that whole base-coat area transparent so the shader gradient
        # remains visible there.
        if name == 'right':
            keep[:, :145] = 0
        else:
            keep[:, 1530:] = 0
        # The lower black rocker and photographed plate are not body artwork.
        if name == 'left':
            rocker = [(0,.855),(.17,.855),(.29,.858),(.34,.852),(.42,.861),(.59,.864),(.75,.862),(.87,.853),(1,.850),(1,1),(0,1)]
            plates = [[(.946,.46),(.987,.46),(.987,.58),(.946,.58)]]
        else:
            rocker = [(0,.824),(.18,.825),(.32,.834),(.48,.837),(.64,.837),(.78,.838),(.91,.831),(1,.820),(1,1),(0,1)]
            plates = [[(.004,.40),(.055,.40),(.055,.55),(.004,.55)]]
        keep[poly_mask(rocker)>0] = 0
        for p in plates: keep[poly_mask(p)>0] = 0
        # Keep the photographed window areas in the printable envelope; only
        # the source taillamp is an exclusion in this band.
        if name == 'left':
            tail_lamp = [(0,135),(116,132),(155,152),(157,180),(116,194),(0,188)]
        else:
            tail_lamp = [(1930,174),(2071,173),(2071,228),(1954,234),(1928,211)]
        # The client wraps the side glazing as part of the continuous print.
        # Keep its local artwork strokes in the same alpha layer as the doors;
        # the runtime lays opaque printed film over an opaque dark tint.
        cv2.fillPoly(keep, [np.asarray(tail_lamp,np.int32)], 0)
        alpha = keep
    else:
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        chroma = np.clip((hsv[:,:,1].astype(np.float32)-40)/75,0,1)
    polys = {
      'left': [(0,.40),(.12,.37),(.28,.33),(.48,.31),(.68,.32),(.86,.35),(1,.39),(1,.84),(.82,.85),(.62,.84),(.38,.84),(.14,.83),(0,.82)],
      'right': [(0,.39),(.14,.35),(.32,.32),(.54,.30),(.74,.32),(.9,.36),(1,.40),(1,.84),(.83,.85),(.60,.84),(.37,.84),(.15,.83),(0,.82)],
      'hood': [(.10,.30),(.18,.29),(.82,.29),(.90,.30),(.89,.70),(.11,.70)],
      'rear': [(.065,.32),(.20,.29),(.225,.02),(.255,.02),(.28,.26),(.72,.26),(.745,.02),(.775,.02),(.80,.29),(.935,.32),(.96,.75),(.88,.78),(.82,.77),(.76,.72),(.72,.68),(.28,.68),(.24,.72),(.18,.77),(.12,.78),(.04,.75)]}
    poly=np.array([[(round(x*(w-1)),round(y*(h-1))) for x,y in polys[name]]],np.int32)
    roi=np.zeros((h,w),np.uint8); cv2.fillPoly(roi,poly,255)
    if name in ('left','right'):
        # Wheels and background gaps are excluded; the adjoining door/fender art remains continuous.
        centers = ([(.214,.73),(.822,.73)] if name=='left' else [(.175,.74),(.783,.74)])
        for x,y in centers: cv2.ellipse(roi,(round(x*w),round(y*h)),(round(.105*w),round(.19*h)),0,0,360,0,-1)
    if name not in ('left','right'):
        # Rear artwork is printed on solid blue paint. Preserve every source
        # pixel within the panel mask, including white and pale-gray graphics.
        keep=cv2.bitwise_and(roi,carmask)
        if name == 'rear':
            # Use the traced rear-panel silhouette directly. GrabCut drops
            # pale lettering and line-work that belongs to the blue paint.
            keep=roi.copy()
            def rear_poly(points):
                pts=np.array([[(round(x*(w-1)),round(y*(h-1))) for x,y in points]],np.int32)
                m=np.zeros((h,w),np.uint8); cv2.fillPoly(m,pts,255); return m
            # Cut out the rear glass and registration plate; tires remain
            # outside the traced lower panel envelope / GrabCut body mask.
            # Keep the clean rear glass out of the decal. Its lower edge is
            # the narrow body seam at about row 230; the pale-blue script
            # immediately below that seam is printed on the upper tailgate.
            glass=[(.235,.085),(.765,.085),(.785,.135),(.775,.245),(.735,.258),(.265,.258),(.225,.245),(.215,.135)]
            plate=[(.375,.645),(.625,.645),(.625,.785),(.375,.785)]
            keep[rear_poly(glass)>0]=0
            keep[rear_poly(plate)>0]=0
            # Exclude the photographed full-width lamp bar, intake/grille,
            # and the two lower tire areas; these are model hardware.
            lightbar=[(.055,.335),(.945,.335),(.96,.392),(.91,.414),(.09,.414)]
            # The printed Unit-00 / warning band finishes just above the
            # actual grille. Keep it in the artwork mask; the grille starts
            # below row 550, not at the band's top edge around row 477.
            grille=[(.135,.62),(.865,.62),(.90,.775),(.84,.805),(.16,.805),(.10,.775)]
            tire_l=[(0,.75),(.16,.75),(.19,1),(0,1)]
            tire_r=[(.84,.75),(1,.75),(1,1),(.81,1)]
            for cutout in (lightbar,grille,tire_l,tire_r): keep[rear_poly(cutout)>0]=0
        elif name == 'hood':
            # The black central lower intake is not painted artwork.
            intake=[(180,808),(1155,808),(1190,861),(1110,882),(225,882),(145,858)]
            cv2.fillPoly(keep,[np.asarray(intake,np.int32)],0)
        alpha=keep
    # Use local structure only to distinguish printed art from broad paint
    # and lighting variation. Keep the response steep so lettering, strokes,
    # and character shapes retain near-full opacity; structural exclusions
    # above remain the authority for lamps, glass, plate, wheels, and grille.
    paint_field = cv2.GaussianBlur(image,(0,0),sigmaX=20,sigmaY=20)
    detail = cv2.cvtColor(cv2.absdiff(image,paint_field),cv2.COLOR_BGR2GRAY).astype(np.float32)
    if name == 'rear':
        # The rear print sits on nearly the same blue as its base coat, so
        # its lettering and warning strokes have much lower local contrast
        # than the side illustrations. Grow those local edge responses back
        # across the printed strokes instead of letting only their one-pixel
        # high-pass cores survive as opaque artwork.
        detail_alpha = np.clip(detail/5.0,0.0,1.0)
        rear_strokes = cv2.dilate((detail >= 2.0).astype(np.uint8)*255,
                                  np.ones((17,17),np.uint8)).astype(np.float32)/255.0
        detail_alpha = np.maximum(detail_alpha, rear_strokes)
    else:
        # Local high-pass structure classifier: a 20 px Gaussian defines the
        # smooth paint field; responses below 8/255 are clear-coat variation,
        # and 8..24/255 ramp to full opacity as strokes/edges appear.
        # A 5x5 max filter carries the detected pigment edges across thin
        # antialiased stroke interiors without admitting broad base-coat areas.
        detail_alpha = np.clip((detail-8.0)/16.0,0.0,1.0)
        detail_alpha = cv2.dilate(detail_alpha,np.ones((5,5),np.uint8))
    # End-on source photographs are already registered illustrations of the
    # painted panels. Keep their complete panel pixels so broad fills and
    # lettering survive the decal projection at the correct physical scale.
    # Side images still use the local-detail matte to avoid copying the photo's
    # body paint and studio shading onto the model.
    if name in ('hood', 'rear'):
        alpha = np.uint8(alpha)
    else:
        alpha = np.uint8(alpha.astype(np.float32)*detail_alpha)
    alpha = cv2.GaussianBlur(alpha,(3,3),.55)
    if name in ('left','right'):
        # Gaussian edge smoothing can bleed a faint pixel back over an exclusion.
        for x,y,rx,ry in wheel_masks:
            cv2.ellipse(alpha,(x,y),(rx,ry),0,0,360,0,-1)
    rgba=cv2.cvtColor(image,cv2.COLOR_BGR2BGRA); rgba[:,:,3]=alpha
    return rgba

def camera_from_wheels(name, width, height, anchors):
    """Side camera whose two axle points exactly land on source photo centres."""
    rear, front = anchors['rear'], anchors['front']
    px_per_m = abs(front[0]-rear[0]) / WHEELBASE_M
    distance = 8.0
    focal = px_per_m * distance
    # camera x-axis points toward +Z on the left side and -Z on the right side.
    sign = 1 if name == 'left' else -1
    # Image coordinates increase downward, so camera screen-Y is -world-Y.
    R = np.array([[0.,0.,sign],[0.,-1.,0.],[sign,0.,0.]])
    pos = np.array([-distance if name == 'left' else distance, rear[2], 0.])
    t = -R @ pos
    # A small forward artwork registration correction, expressed in the
    # wheelbase datum. Source X runs frontward on the left photo and rearward
    # on the right photo, so the principal-point correction changes sign.
    forward_shift_wb=.02
    direction = -1 if name == 'left' else 1
    cx=(rear[0]+front[0])/2 + direction*forward_shift_wb*abs(front[0]-rear[0])
    cy=(rear[1]+front[1])/2
    K=np.array([[focal,0,cx],[0,focal,cy],[0,0,1.]])
    return {'intrinsics_px':K.tolist(),'rotation_matrix_world_to_camera':R.tolist(),
      'translation_camera':t.tolist(),'camera_position_world':pos.tolist(),
      'camera_distance_m':distance,'focal_px':float(focal),'source_dimensions_px':[width,height],
      'fit_method':f'front/rear wheel-centre affine datum; {WHEELBASE_M:.3f} m model wheelbase; artwork shifted forward {forward_shift_wb:.3f} wheelbases',
      'wheel_arch_centres_px':{'rear':[rear[0],rear[1]],'front':[front[0],front[1]]},
      'wheelbase_px':abs(front[0]-rear[0]),
      'artwork_forward_shift_wheelbases':forward_shift_wb,
      'artwork_extent_wheelbases': ([1.32,.18] if name=='left' else [.18,1.33])}

def camera_end(name,width,height):
    """Register head-on views to the corresponding end shell and lamp span."""
    if name=='hood':
        pos=np.array([0.,3.0,7.5]); target=np.array([0.,.78,1.75]); body_width=2.18
    else:
        pos=np.array([0.,3.0,-7.0]); target=np.array([0.,.80,-2.15]); body_width=2.05
    forward=target-pos; forward/=np.linalg.norm(forward)
    right=np.cross(forward,np.array([0.,1.,0.])); right/=np.linalg.norm(right)
    up=np.cross(right,forward)
    R=np.stack([right,-up,forward])
    distance=np.linalg.norm(target-pos)
    focal=width/body_width*distance*.94
    cy=height*.51
    K=np.array([[focal,0,width/2],[0,focal,cy],[0,0,1.]])
    t=-R@pos
    return {'intrinsics_px':K.tolist(),'rotation_matrix_world_to_camera':R.tolist(),
      'translation_camera':t.tolist(),'camera_position_world':pos.tolist(),
      'camera_distance_m':float(distance),'focal_px':float(focal),'source_dimensions_px':[width,height],
      'fit_method':'end-on lamp/body-width registration; wheel arches not visible',
      'wheel_arch_centres_px':None,'wheelbase_px':None,'artwork_extent_wheelbases':None}

def make_part_map():
    scene=trimesh.load(MODEL,force='scene',process=False)
    body=None
    for node in scene.graph.nodes_geometry:
        T,g=scene.graph[node]; mesh=scene.geometry[g]
        if getattr(getattr(mesh.visual,'material',None),'name','') == 'corpus1':
            body=(node,g,mesh,trimesh.transform_points(mesh.vertices,T)); break
    if body is None: raise RuntimeError('corpus1 body mesh not found')
    node,g,mesh,vertices=body
    tri=vertices[mesh.faces].mean(axis=1)
    fz=tri[:,2]; fy=tri[:,1]
    face_ranges={}
    for name,rule in PARTS.items():
        if 'z' not in rule:
            if rule.get('mesh_material'):
                nodes=[]
                for other in scene.graph.nodes_geometry:
                    T2,g2=scene.graph[other]; m2=scene.geometry[g2]
                    if getattr(getattr(m2.visual,'material',None),'name','')==rule['mesh_material']:
                        pts=trimesh.transform_points(m2.vertices,T2)
                        nodes.append({'node':other,'vertex_count':int(len(pts)),'extent_m':{'min':pts.min(0).tolist(),'max':pts.max(0).tolist()}})
                face_ranges[name]={'mesh_material':rule['mesh_material'],'separate_meshes':nodes,'classification':'named separate mesh'}
            continue
        lo,hi=rule['z']; ylo,yhi=rule['y']
        hit=np.where((fz>=lo)&(fz<hi)&(fy>=ylo)&(fy<yhi))[0]
        face_ranges[name]={'face_index_ranges':ranges(hit),'face_count':int(len(hit)),
          'vertex_index_ranges':ranges(np.unique(mesh.faces[hit].reshape(-1))),
          'extent_m':{'x':[-1.089,1.089],'y':[ylo,yhi],'z':[lo,hi]},'classification':'spatial approximation on corpus1'}
    data={'model':'assets/taycan_f.glb','body_mesh_node':node,'body_geometry':g,
      'material':'corpus1','wheelbase_datum_m':WHEELBASE_M,
      'wheel_arch_centres_model_m':{'front':[0,.35,WHEEL_CENTRES['front']],'rear':[0,.35,WHEEL_CENTRES['rear']]},
      'measured_model_wheelbase_m':WHEEL_CENTRES['front']-WHEEL_CENTRES['rear'],
      'panel_seams':'GLB has a single continuous corpus1 shell with no panel IDs. Door and bumper seams are estimated from Taycan proportions; wheel centres are hard datums.',
      'parts':face_ranges,'named_regions':PARTS}
    (SRC/'parts.json').write_text(json.dumps(data,indent=2))
    return data

def ranges(ids):
    if len(ids)==0:return []
    ids=np.asarray(ids,dtype=int); cuts=np.where(np.diff(ids)>1)[0]+1
    groups=np.split(ids,cuts)
    return [[int(group[0]),int(group[-1])] for group in groups]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--sides-only',action='store_true',help='Rebuild left/right textures and camera calibration only; preserve hood/rear outputs.')
    parser.add_argument('--final-pass',action='store_true',help='Rebuild side and rear textures; preserve hood texture and camera.')
    parser.add_argument('--front-only',action='store_true',help='Rebuild only the two-band front texture and its registration metadata.')
    parser.add_argument('--rear-only',action='store_true',help='Rebuild only rear.png and preserve side, hood, and camera outputs.')
    args=parser.parse_args()
    parts_path=SRC/'parts.json'
    if args.front_only or args.rear_only:
        parts=json.loads(parts_path.read_text())
    elif args.sides_only or args.final_pass:
        parts=json.loads(parts_path.read_text()) if parts_path.exists() else make_part_map()
    else:
        parts=make_part_map()
    # Wheel centres are manually verified against the visible wheel hubs in each photo.
    anchors={'left':{'rear':[358.,355.,.34],'front':[1375.,361.,.34]},
             'right':{'front':[363.,443.,.34],'rear':[1621.,439.,.34]}}
    cams={}; files={}
    names=('hood',) if args.front_only else ('rear',) if args.rear_only else ('left','right','rear') if args.final_pass else ('left','right') if args.sides_only else ('left','right','hood','rear')
    old_cameras=json.loads((OUT/'cameras.json').read_text()) if (args.sides_only or args.final_pass or args.front_only or args.rear_only) and (OUT/'cameras.json').exists() else {'cameras':{},'textures':{}}
    cams=dict(old_cameras.get('cameras',{})); files=dict(old_cameras.get('textures',{}))
    for name in names:
        im=cv2.imread(str(SRC/f'{name}.jpg'))
        if im is None: raise FileNotFoundError(SRC/f'{name}.jpg')
        car=np.zeros(im.shape[:2],np.uint8) if name=='hood' else source_car_mask(name,im)
        rgba=paint_mask(name,im,car)
        out=OUT/f'{name}.png'; cv2.imwrite(str(out),rgba,[cv2.IMWRITE_PNG_COMPRESSION,6]); files[name]=out.name
        if name in anchors: cam=camera_from_wheels(name,im.shape[1],im.shape[0],anchors[name])
        else:
            cam=camera_end(name,im.shape[1],im.shape[0])
        cams[name]=cam
    landmarks={
      'left':{'source_dimensions_px':[1673,485],'wheel_arch_centres_px':{'rear':[358,355],'front':[1375,361]},'wheelbase_px':1017,'main_art_extent_px_x':[30,1192],'main_art_extent_relative_to_front_arch_wb':[1.32,.18],'thin_front_accent_extent_px_x':[1192,1496],'thin_front_accent_past_front_arch_wb':.12,'covered_model_parts':['rear_fender','rear_door','front_door','front_fender accents']},
      'right':{'source_dimensions_px':[2072,600],'wheel_arch_centres_px':{'front':[363,443],'rear':[1621,439]},'wheelbase_px':1258,'main_art_extent_px_x':[589,2031],'main_art_extent_relative_to_front_arch_wb':[.18,1.33],'thin_front_accent_extent_px_x':[212,589],'thin_front_accent_past_front_arch_wb':.12,'covered_model_parts':['front_fender accents','front_door','rear_door','rear_fender']},
      'hood':{'source_dimensions_px':[1337,884],'wheel_arch_centres_px':None,'wheelbase_px':None,'lamp_centres_px':[[240,420],[1090,420]],'landmark_note':'end-on crop; no wheel arches visible; calibrated from lamp and body width','covered_model_parts':['hood','small front-bumper accents']},
      'rear':{'source_dimensions_px':[1291,891],'wheel_arch_centres_px':None,'wheelbase_px':None,'lamp_span_px_x':[85,1215],'landmark_note':'end-on crop; no wheel arches visible; calibrated from lamp and body width','covered_model_parts':['boot_tailgate','rear bumper corners']}}
    parts['artwork_exclusions_px']={
      'left':{'lamp':[[0,132,157,194]],'plate':[[1581,223,1651,282]],'tyres':[[185,208,535,498],[1195,217,1555,507]],'notes':'Wheel ellipses include about 12 px clearance around the full visible discs and tyres. Glazing is intentionally included as a wrap surface; lamps and plate remain structural exclusions. Side photo is 1673x485.'},
      'right':{'lamp':[[1928,173,2071,234]],'plate':[[8,240,114,330]],'tyres':[[145,300,545,590],[1370,297,1690,587]],'notes':'Wheel ellipses include about 12 px clearance around the full visible discs and tyres. Glazing is intentionally included as a wrap surface; lamps and plate remain structural exclusions. Side photo is 2072x600.'},
      'hood':{'glass':[[0,0,1337,264]],'lamps':[[91,375,372,486],[965,375,1246,486]],'plate':[[500,533,871,668]],'grille_intake':[[145,808,1190,882]],'notes':'Windshield is excluded by the hood/bumper surface envelope; photo is 1337x884.'},
      'rear':{'glass':[[277,75,1013,254]],'lamp_bar':[[71,298,1220,369]],'plate':[[483,574,807,700]],'grille_intake':[[129,552,1162,717]],'tyres':[[0,667,246,891],[1045,667,1291,891]],'notes':'Lamp bar remains cut out except bright client PORSCHE lettering at x=390..900, y=282..326. Grille starts below the printed Unit-00/warning band; rear photo is 1291x891.'}}
    if args.rear_only:
        pass
    elif args.sides_only or args.final_pass:
        parts['photo_landmarks']={**parts.get('photo_landmarks',{}),'left':landmarks['left'],'right':landmarks['right']}
    elif args.front_only:
        parts['photo_landmarks']={**parts.get('photo_landmarks',{}),'hood':{
          **parts.get('photo_landmarks',{}).get('hood',{}),
          'source_dimensions_px':[1337,884],
          'hood_bumper_crease_row_px':494,
          'model_crease_height_m':0.87,
          'front_projection_regions':['hood','front_bumper'],
          'band_scale_factors':{'upper_hood':1.0,'lower_bumper':1.0},
          'scale_note':'Both bands retain the original source pixel grid and share the calibrated camera at the crease datum.'}}
    else:
        parts['photo_landmarks']=landmarks
    if not args.front_only: parts['wheelbase_datum_m']=WHEELBASE_M
    (parts_path).write_text(json.dumps(parts,indent=2))
    camera_data={'cameras':cams,'textures':files,'alignment':'semantic part mapping; side photographs calibrated to axle centres'}
    if args.front_only:
        camera_data['front_registration']={'source_crease_row_px':494,'model_crease_height_m':0.87,'model_crease_z_m':2.2,'upper_scale_factor':1.0,'lower_scale_factor':1.0,'scale_basis':'original source pixels, no resize; shared front-camera datum'}
    (OUT/'cameras.json').write_text(json.dumps(camera_data,indent=2))
    print(f'Wrote panel map for {parts["body_geometry"]} and {len(names)} processed artwork images.')
    print('Side wheelbase pixels:',{n:cams[n]['wheelbase_px'] for n in ('left','right')})

if __name__=='__main__': main()
