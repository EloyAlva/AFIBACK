Para actualizar una instalación existente, ejecutar el contenido completo de
`migrations/008_registered_invitations.sql` en Supabase → SQL Editor como postgres.
Esta migración agrega invitaciones dirigidas a usuarios registrados y sus funciones;
conserva las cuentas, movimientos e invitaciones anteriores.

Después de aplicarla:
- Espacios → Invitar usuarios registrados permite listar y buscar por nombre o usuario.
- Crear un objetivo compartido como administrador abre el selector para invitar.
- La persona recibe un aviso dentro de AFI y puede aceptar o rechazar en Notificaciones o Espacios.
- La bandeja se actualiza cada 30 segundos y al volver a la ventana.
- Aceptar incorpora al espacio completo y permite ver todos sus objetivos compartidos.
  Las cuentas personales conservan su privacidad y los miembros nuevos no son administradores.
- Las invitaciones caducan a los siete días; el administrador puede revocarlas.

La instalación completa generada incluye esta migración tanto para bases nuevas
como para instalaciones existentes. También se puede ejecutar la migración 008
por separado: es repetible y solicita recargar la caché de PostgREST al terminar.

Si aparece «Could not find the function public.search_registered_users(q, s)
in the schema cache», ejecutar la migración 008 completa en el mismo proyecto
Supabase usado por AFI. El orden de q y s en el mensaje no es un problema:
la llamada usa parámetros por nombre.
