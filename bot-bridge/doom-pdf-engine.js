/**
 * ============================================================================
 * DOOMLATER - MOTOR PROFESIONAL DE FACTURAS Y CONTRATOS EN PDF
 * Genera documentos PDF con el diseño oficial de ItsDoomlater usando PDFKit
 * ============================================================================
 */

import PDFDocument from 'pdfkit';

/**
 * Genera la Factura Digital oficial de ItsDoomlater
 * @param {Object} data
 * @param {string} data.clientName - Nombre del cliente (ej: "Sr. Máximo")
 * @param {Array} data.items - Lista de equipos / servicios
 * @param {number} [data.abonoHoy] - Monto abonado hoy en USD (opcional)
 * @param {number} [data.bcvRate] - Tasa oficial BCV (opcional)
 * @param {string} [data.invoiceNumber] - Número de recibo (ej: "IDL-2026-1028")
 * @param {string} [data.dateStr] - Fecha formateada
 * @returns {Promise<Buffer>}
 */
export async function generateDoomDigitalInvoicePdf(data = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 30, bottom: 30, left: 30, right: 30 },
        bufferPages: true
      });

      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const now = new Date();
      const dateStr = data.dateStr || now.toLocaleDateString('es-VE', { day: 'numeric', month: 'long', year: 'numeric' });
      const invoiceNum = data.invoiceNumber || `IDL-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const clientName = data.clientName || 'Cliente';
      const bcvRate = Number(data.bcvRate) || 890;

      // Normalizar items
      const rawItems = Array.isArray(data.items) && data.items.length > 0
        ? data.items
        : [{
            title: 'Servicio Técnico Especializado',
            tag: 'REVISIÓN GENERAL',
            desc: 'Servicio de revisión y mantenimiento técnico integral.',
            status: 'Abonado / Pagado Hoy',
            abonado: 15,
            total: 15
          }];

      let valorTotal = 0;
      let abonoTotal = 0;

      const items = rawItems.map((it, idx) => {
        const total = Number(it.total ?? it.costoTotal ?? it.price ?? 0);
        const abonado = Number(it.abonado ?? it.abonoHoy ?? (it.paid ? total : 0));
        valorTotal += total;
        abonoTotal += abonado;
        const isPaid = abonado >= total && total > 0;
        return {
          num: String(idx + 1).padStart(2, '0'),
          title: it.title || it.name || it.description || 'Reparación de Control / Consola',
          tag: it.tag || (it.color ? `COLOR ${String(it.color).toUpperCase()}` : ''),
          desc: it.desc || it.descriptionDetail || (isPaid ? 'Servicio de reparación y mantenimiento técnico integral. (Ya pagado / abonado el día de hoy).' : 'Servicio de reparación técnica, reemplazo/ajuste de componentes internos, calibración y pruebas de funcionamiento. (Queda pendiente por pagar).'),
          status: it.status || (isPaid ? 'Abonado / Pagado Hoy' : 'Pendiente por Pagar'),
          abonado,
          total
        };
      });

      // Si se pasó un abono explícito general que difiere
      if (typeof data.abonoHoy === 'number' && !isNaN(data.abonoHoy)) {
        abonoTotal = data.abonoHoy;
      }

      const saldoPendiente = Math.max(0, valorTotal - abonoTotal);
      const isAbonoParcial = saldoPendiente > 0;
      const statusPillText = isAbonoParcial ? 'ABONO PARCIAL • SALDO PENDIENTE' : 'PAGADO COMPLETO • CONCLUIDO';
      const statusPillColor = isAbonoParcial ? '#F59E0B' : '#10B981';

      // ------------------------------------------------------------------------
      // 1. BANNER SUPERIOR OSCURO (Header)
      // ------------------------------------------------------------------------
      const bannerX = 30;
      const bannerY = 30;
      const bannerW = 552;
      const bannerH = 75;

      doc.rect(bannerX, bannerY, bannerW, bannerH).fill('#0B132B');

      // Icono Instagram estilizado
      const iconX = 42;
      const iconY = 44;
      doc.roundedRect(iconX, iconY, 26, 26, 6).lineWidth(1.5).strokeColor('#FFFFFF').stroke();
      doc.circle(iconX + 13, iconY + 13, 6).lineWidth(1.5).strokeColor('#FFFFFF').stroke();
      doc.circle(iconX + 20, iconY + 7, 1.5).fillColor('#FFFFFF').fill();

      // Textos de marca izquierda
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13).text('ITSDOOMLATER', 76, 42);
      doc.fillColor('#CBD5E1').font('Helvetica').fontSize(8).text('Instagram: @itsdoomlater', 76, 57);
      doc.fillColor('#94A3B8').font('Helvetica').fontSize(6.5).text('Servicio Técnico Especializado en Consolas, Controles y Microsoldadura', 76, 68);

      // Textos encabezado derecha
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15).text('FACTURA DIGITAL', 320, 38, { width: 250, align: 'right' });
      doc.fillColor('#E2E8F0').font('Helvetica').fontSize(8).text(`N.º Recibo: ${invoiceNum}`, 320, 56, { width: 250, align: 'right' });
      doc.fillColor('#CBD5E1').font('Helvetica').fontSize(8).text(`Fecha: ${dateStr}`, 320, 68, { width: 250, align: 'right' });

      // Badge de estado (Pill)
      const pillW = 180;
      const pillH = 15;
      const pillX = bannerX + bannerW - pillW - 10;
      const pillY = bannerY + bannerH - pillH - 6;
      doc.roundedRect(pillX, pillY, pillW, pillH, 7).fill(statusPillColor);
      doc.fillColor('#0B132B').font('Helvetica-Bold').fontSize(7.5).text(statusPillText, pillX, pillY + 3.5, { width: pillW, align: 'center' });

      // ------------------------------------------------------------------------
      // 2. METADATA: 2 CAJAS (TALLER / EMISOR y DETALLE DE FACTURACIÓN)
      // ------------------------------------------------------------------------
      const boxY = 114;
      const boxW = 271;
      const boxH = 88;

      // Caja Izquierda
      doc.roundedRect(bannerX, boxY, boxW, boxH, 4).lineWidth(0.8).strokeColor('#E2E8F0').stroke();
      doc.fillColor('#2563EB').font('Helvetica-Bold').fontSize(7.5).text('TALLER / EMISOR', bannerX + 10, boxY + 8);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9).text('ItsDoomlater — Laboratorio Técnico', bannerX + 10, boxY + 20);
      doc.fillColor('#334155').font('Helvetica').fontSize(8.5).text(`Cliente: ${clientName}`, bannerX + 10, boxY + 34);
      doc.fillColor('#475569').font('Helvetica').fontSize(8).text('Instagram: @itsdoomlater', bannerX + 10, boxY + 48);
      doc.fillColor('#475569').font('Helvetica').fontSize(7.5).text('Correo: itsdoomlater@gmail.com | Caracas, Venezuela', bannerX + 10, boxY + 62);

      // Caja Derecha
      const box2X = bannerX + boxW + 10;
      const equiposSummary = items.length === 1 ? `1x ${items[0].title}` : `${items.length}x Equipos (${items.map(i => i.tag ? i.tag.replace('COLOR ', '') : i.title).join(' y ')})`;
      doc.roundedRect(box2X, boxY, boxW, boxH, 4).lineWidth(0.8).strokeColor('#E2E8F0').stroke();
      doc.fillColor('#2563EB').font('Helvetica-Bold').fontSize(7.5).text('DETALLE DE FACTURACIÓN Y ESTADO', box2X + 10, boxY + 8);
      doc.fillColor('#334155').font('Helvetica-Bold').fontSize(8.5).text(`Equipos: ${equiposSummary}`, box2X + 10, boxY + 20);
      doc.fillColor('#475569').font('Helvetica').fontSize(7.5).text('Moneda de Facturación: USD $ (Tasa Banco Central de Venezuela - BCV)', box2X + 10, boxY + 34);
      doc.fillColor('#15803D').font('Helvetica-Bold').fontSize(8).text(`Abono Registrado Hoy: $${abonoTotal.toFixed(2)} USD`, box2X + 10, boxY + 48);
      if (saldoPendiente > 0) {
        doc.fillColor('#B45309').font('Helvetica-Bold').fontSize(8).text(`Estado de Cuenta: Pendiente por pagar $${saldoPendiente.toFixed(2)} USD`, box2X + 10, boxY + 62);
      } else {
        doc.fillColor('#15803D').font('Helvetica-Bold').fontSize(8).text(`Estado de Cuenta: Cancelado en su totalidad`, box2X + 10, boxY + 62);
      }

      // ------------------------------------------------------------------------
      // 3. TÍTULO DE SECCIÓN CON LÍNEA AZUL LATERAL
      // ------------------------------------------------------------------------
      const secY = 210;
      doc.rect(bannerX, secY, 3, 14).fill('#2563EB');
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9.5).text('DESGLOSE DE SERVICIOS TÉCNICOS Y ESTADO DE PAGO', bannerX + 8, secY + 2);

      // ------------------------------------------------------------------------
      // 4. TABLA DE SERVICIOS
      // ------------------------------------------------------------------------
      const tableY = 230;
      const tableW = 552;
      const thH = 20;

      // Header Tabla
      doc.rect(bannerX, tableY, tableW, thH).fill('#0B132B');
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7);
      doc.text('#', bannerX + 8, tableY + 6, { width: 22 });
      doc.text('DESCRIPCIÓN DEL EQUIPO Y SERVICIO', bannerX + 32, tableY + 6, { width: 260 });
      doc.text('ESTADO DEL PAGO', bannerX + 300, tableY + 6, { width: 110 });
      doc.text('ABONADO HOY', bannerX + 415, tableY + 6, { width: 60, align: 'right' });
      doc.text('COSTO TOTAL', bannerX + 480, tableY + 6, { width: 62, align: 'right' });

      let currentY = tableY + thH;

      items.forEach((it) => {
        const rowH = 54;
        doc.rect(bannerX, currentY, tableW, rowH).fill('#FFFFFF');
        doc.moveTo(bannerX, currentY + rowH).lineTo(bannerX + tableW, currentY + rowH).lineWidth(0.5).strokeColor('#E2E8F0').stroke();

        // Col 1: #
        doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9).text(it.num, bannerX + 8, currentY + 12);

        // Col 2: Descripción y Tag
        doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9).text(it.title, bannerX + 32, currentY + 8);
        if (it.tag) {
          const tagW = doc.widthOfString(it.tag) + 10;
          doc.roundedRect(bannerX + 32, currentY + 21, tagW, 11, 3).fill('#DCFCE7');
          doc.fillColor('#15803D').font('Helvetica-Bold').fontSize(6.5).text(it.tag, bannerX + 37, currentY + 23);
        }
        doc.fillColor('#64748B').font('Helvetica').fontSize(7).text(it.desc, bannerX + 32, currentY + 34, { width: 255 });

        // Col 3: Estado de pago (Pill)
        const isPaidRow = it.status.toLowerCase().includes('abona') || it.status.toLowerCase().includes('pago');
        const rPillBg = isPaidRow ? '#DCFCE7' : '#FEF3C7';
        const rPillColor = isPaidRow ? '#15803D' : '#B45309';
        doc.roundedRect(bannerX + 300, currentY + 12, 100, 15, 4).fill(rPillBg);
        doc.fillColor(rPillColor).font('Helvetica-Bold').fontSize(7).text(it.status, bannerX + 300, currentY + 16, { width: 100, align: 'center' });

        // Col 4: Abonado Hoy
        doc.fillColor('#334155').font('Helvetica').fontSize(8.5).text(`$${it.abonado.toFixed(2)}`, bannerX + 415, currentY + 14, { width: 60, align: 'right' });

        // Col 5: Costo Total
        doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(8.5).text(`$${it.total.toFixed(2)}`, bannerX + 480, currentY + 14, { width: 62, align: 'right' });

        currentY += rowH;
      });

      // ------------------------------------------------------------------------
      // 5. RESUMEN INFERIOR (2 CAJAS)
      // ------------------------------------------------------------------------
      const sumY = currentY + 12;
      const sumH = 145;

      // Caja Izquierda: Constancia de Abono y Saldo Pendiente
      doc.roundedRect(bannerX, sumY, boxW, sumH, 4).lineWidth(0.8).strokeColor('#E2E8F0').stroke();
      doc.fillColor('#2563EB').font('Helvetica-Bold').fontSize(8).text('CONSTANCIA DE ABONO Y SALDO PENDIENTE', bannerX + 10, sumY + 10);

      const bsAbono = abonoTotal * bcvRate;
      const bsPendiente = saldoPendiente * bcvRate;

      doc.fillColor('#334155').font('Helvetica').fontSize(7.2);
      doc.text(
        `• Abono recibido hoy (${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}): El cliente abona la cantidad de $${abonoTotal.toFixed(2)} USD (~Bs. ${bsAbono.toLocaleString('es-VE', { minimumFractionDigits: 2 })}) cubriendo los conceptos detallados en la tabla.`,
        bannerX + 10, sumY + 24, { width: boxW - 20 }
      );

      doc.text(
        saldoPendiente > 0
          ? `• Saldo pendiente por pagar: Queda pendiente de pago la cantidad de $${saldoPendiente.toFixed(2)} USD (~Bs. ${bsPendiente.toLocaleString('es-VE', { minimumFractionDigits: 2 })} a tasa oficial BCV de ${bcvRate.toFixed(2)} Bs/$) correspondientes a la entrega final.`
          : `• Saldo pendiente por pagar: No queda saldo pendiente. El servicio ha sido cancelado en su totalidad.`,
        bannerX + 10, sumY + 62, { width: boxW - 20 }
      );

      doc.fillColor('#64748B').font('Helvetica-Oblique').fontSize(6.8);
      doc.text(
        `• Garantía Técnica: Garantía oficial de 30 días continuos sobre mano de obra y piezas intervenidas (no aplica por golpes, humedad, caídas o manipulación por terceros).`,
        bannerX + 10, sumY + 102, { width: boxW - 20 }
      );

      // Caja Derecha: Totales y Saldo Destacado
      doc.roundedRect(box2X, sumY, boxW, sumH, 4).lineWidth(0.8).strokeColor('#E2E8F0').stroke();

      doc.fillColor('#334155').font('Helvetica').fontSize(8.5).text(`Valor Total (${items.length} Equipo${items.length > 1 ? 's' : ''}):`, box2X + 10, sumY + 14);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9).text(`$${valorTotal.toFixed(2)} USD`, box2X + 120, sumY + 14, { width: boxW - 130, align: 'right' });

      doc.fillColor('#15803D').font('Helvetica').fontSize(8.5).text('(-) Abono Recibido Hoy:', box2X + 10, sumY + 30);
      doc.fillColor('#15803D').font('Helvetica-Bold').fontSize(9).text(`-$${abonoTotal.toFixed(2)} USD`, box2X + 120, sumY + 30, { width: boxW - 130, align: 'right' });

      doc.moveTo(box2X + 10, sumY + 48).lineTo(box2X + boxW - 10, sumY + 48).lineWidth(0.5).strokeColor('#E2E8F0').stroke();

      // Recuadro dorado/naranja destacado
      const alertBoxY = sumY + 54;
      const alertBoxH = 46;
      doc.roundedRect(box2X + 10, alertBoxY, boxW - 20, alertBoxH, 4).fillAndStroke('#FEF3C7', '#FDE68A');
      doc.fillColor('#B45309').font('Helvetica-Bold').fontSize(8).text(saldoPendiente > 0 ? 'RESTA / FALTA POR PAGAR:' : 'TOTAL CANCELADO:', box2X + 16, alertBoxY + 8);
      doc.fillColor('#B45309').font('Helvetica-Bold').fontSize(14).text(`$${(saldoPendiente > 0 ? saldoPendiente : valorTotal).toFixed(2)} USD`, box2X + 16, alertBoxY + 22);

      doc.fillColor('#64748B').font('Helvetica').fontSize(6.8).text(
        `* Pagadero en USD o Bolívares a la tasa del Banco Central de Venezuela (BCV)`,
        box2X + 10, alertBoxY + alertBoxH + 12, { width: boxW - 20, align: 'center' }
      );

      // ------------------------------------------------------------------------
      // 6. PIE DE PÁGINA
      // ------------------------------------------------------------------------
      const footerY = 740;
      doc.moveTo(bannerX, footerY).lineTo(bannerX + bannerW, footerY).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
      doc.fillColor('#64748B').font('Helvetica').fontSize(7.5).text(
        '@itsdoomlater • WhatsApp: +58 0414-2005801 • Gracias por confiar el mantenimiento de tus equipos a ItsDoomlater.',
        bannerX, footerY + 8, { width: bannerW, align: 'center' }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Genera el Acuerdo / Contrato oficial de Doomlater con cláusulas, alertas y firmas
 * @param {Object} data
 * @param {string} data.personName - Nombre de la contraparte (ej: "Diego Santiago Carvajal Ornelas")
 * @param {string} [data.personId] - Cédula (ej: "V-33.267.135")
 * @param {string} [data.title] - Título del acuerdo
 * @param {string} [data.role] - Rol de la contraparte (ej: "EL ASOCIADO", "EL CLIENTE")
 * @returns {Promise<Buffer>}
 */
export async function generateDoomContractPdf(data = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 45, bottom: 45, left: 45, right: 45 },
        bufferPages: true
      });

      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const personName = data.personName || data.clientName || 'Diego Santiago Carvajal Ornelas';
      const personId = data.personId || data.cedula || 'V-33.267.135';
      const rawTitle = data.title || data.serviceName || 'ACUERDO DE ASOCIACIÓN DE VENTAS Y CAPACITACIÓN TÉCNICA';
      const title = rawTitle.toUpperCase();

      const isAssociation = /(asociaci|capacita|ventas|aprendizaje)/i.test(title);
      const role = isAssociation ? (data.role || 'EL ASOCIADO') : (data.role || 'EL CLIENTE');
      const roleFull = isAssociation ? (data.roleFull || 'Asociado en Capacitación') : (data.roleFull || 'Cliente Beneficiario');
      const footerSubtitle = isAssociation ? 'Programa de Capacitación Interna' : 'Contrato Oficial de Servicio Técnico y Garantía';

      if (isAssociation) {
        // ------------------------------------------------------------------------
        // MODELO ASOCIACIÓN Y CAPACITACIÓN TÉCNICA (3 PÁGINAS)
        // ------------------------------------------------------------------------
        // PÁGINA 1
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(14).text(title, { align: 'center' });
        doc.moveDown(0.6);
        doc.moveTo(45, doc.y).lineTo(567, doc.y).lineWidth(1).strokeColor('#000000').stroke();
        doc.moveDown(0.8);

        doc.fillColor('#000000').font('Helvetica').fontSize(9.5).text(
          `El presente documento establece los términos de colaboración entre Doomlater (en adelante "LA EMPRESA") y ${personName}, titular de la C.I. ${personId} (en adelante "${role}"), combinando la generación de ingresos comerciales con la capacitación técnica progresiva.`,
          { align: 'justify', lineGap: 3 }
        );
        doc.moveDown(1.2);

        // FASE 1
        const p1BarY = doc.y;
        doc.rect(45, p1BarY, 3, 14).fill('#000000');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10.5).text('FASE 1: GESTIÓN COMERCIAL Y CAPTACIÓN (PRIORIDAD PRINCIPAL)', 54, p1BarY + 1.5);
        doc.moveDown(0.8);

        doc.fillColor('#000000').font('Helvetica').fontSize(9).text(
          `El objetivo primordial del Asociado será la captación activa de nueva clientela para los servicios de LA EMPRESA. Esta labor garantiza sus ingresos inmediatos mientras se desarrolla su capacitación técnica.`,
          { align: 'justify', lineGap: 2.5 }
        );
        doc.moveDown(0.6);

        const f1Bullets = [
          ['Responsabilidades: ', 'Promoción activa de los servicios de reparación, mantenimiento y modificación a través de redes sociales, referidos, grupos y gestión directa.'],
          ['Comisión por Captación (15%): ', 'Si EL ASOCIADO únicamente trae al cliente, pero el trabajo físico (desarme, diagnóstico, soldadura) y el riesgo técnico lo asume totalmente LA EMPRESA, la comisión a cobrar será del 15% de la ganancia neta del servicio.'],
          ['Remuneración por Asistencia (Sin traer cliente): ', 'Si EL ASOCIADO realiza trabajos de Nivel 1 (limpieza, software, formateo) en equipos captados por LA EMPRESA, recibirá un pago fijo preacordado por cada equipo exitosamente preparado.'],
          ['Condición de pago: ', 'Las comisiones se liquidarán única y exclusivamente cuando el cliente final haya cancelado la totalidad del servicio.']
        ];

        f1Bullets.forEach(([boldPart, textPart]) => {
          doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text('• ' + boldPart, { continued: true });
          doc.font('Helvetica').text(textPart, { align: 'justify', lineGap: 2 });
          doc.moveDown(0.4);
        });

        doc.moveDown(0.8);

        // FASE 2
        const p2BarY = doc.y;
        doc.rect(45, p2BarY, 3, 14).fill('#000000');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10.5).text('FASE 2: ASISTENCIA TÉCNICA DE NIVEL 1 (CERO RIESGO)', 54, p2BarY + 1.5);
        doc.moveDown(0.8);

        doc.fillColor('#000000').font('Helvetica').fontSize(9).text(
          `Para familiarizarse con el ecosistema de trabajo sin poner en riesgo el capital de LA EMPRESA ni los equipos de los clientes, EL ASOCIADO realizará tareas de preparación y logística técnica.`,
          { align: 'justify', lineGap: 2.5 }
        );
        doc.moveDown(0.6);

        const f2Bullets = [
          ['Preparación de Software: ', 'Descarga de archivos, formateo y configuración de memorias MicroSD, y gestión de respaldos.'],
          ['Acondicionamiento Físico: ', 'Limpieza externa detallada de carcasas, controles y pantallas utilizando alcohol isopropílico.'],
          ['Organización: ', 'Mantenimiento del orden en la estación de trabajo y clasificación de tornillería y herramientas.']
        ];

        f2Bullets.forEach(([boldPart, textPart]) => {
          doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text('• ' + boldPart, { continued: true });
          doc.font('Helvetica').text(textPart, { align: 'justify', lineGap: 2 });
          doc.moveDown(0.4);
        });

        doc.moveDown(0.8);

        // RECUADRO NOTA ESTRICTA CON BORDE ROJO
        const alertY = doc.y;
        const alertW = 522;
        const alertH = 50;
        doc.rect(45, alertY, alertW, alertH).lineWidth(0.6).strokeColor('#E2E8F0').stroke();
        doc.rect(45, alertY, 3.5, alertH).fill('#DC2626');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8.2).text('NOTA ESTRICTA: ', 54, alertY + 8, { continued: true });
        doc.font('Helvetica').text(
          'Queda terminantemente prohibido que EL ASOCIADO abra, desarme o aplique herramientas (cautín, estación de calor, destornilladores) en equipos funcionales de clientes durante esta fase. Cualquier daño ocasionado por incumplir esta norma será descontado de sus comisiones.',
          { width: alertW - 16, align: 'justify', lineGap: 2 }
        );

        // PÁGINA 2
        doc.addPage();

        // FASE 3
        const f3Y = doc.y;
        doc.rect(45, f3Y, 3, 14).fill('#000000');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10.5).text('FASE 3: CAPACITACIÓN EN MICROSOLDADURA (PLAN DE APRENDIZAJE)', 54, f3Y + 1.5);
        doc.moveDown(0.8);

        doc.fillColor('#000000').font('Helvetica').fontSize(9).text(
          `El entrenamiento en soldadura se realizará fuera del horario de alta demanda y estará sujeto a las siguientes normativas de consumo responsable de insumos:`,
          { align: 'justify', lineGap: 2.5 }
        );
        doc.moveDown(0.6);

        const f3Bullets = [
          ['Práctica en Chatarra: ', 'Toda práctica inicial se realizará exclusivamente sobre placas base muertas ("chatarra") provistas por LA EMPRESA o EL ASOCIADO.'],
          ['Uso de Insumos: ', 'EL ASOCIADO utilizará estaño y flux de categoría estándar para sus prácticas. El uso de insumos premium (flux de alta gama, pasta térmica, etc.) destinados a los clientes está restringido.'],
          ['Meta a Corto Plazo y Transición (Enero): ', 'El objetivo técnico establecido para enero es que EL ASOCIADO domine la soldadura de Conectores FPC y Puertos de Carga.'],
          ['Comisión por Trabajo Físico (40%): ', 'Una vez EL ASOCIADO tenga la capacidad de realizar el trabajo físico completo de una reparación (diagnóstico, desarme, soldadura y armado) por su cuenta, cobrará el 40% de la mano de obra. Nota aclaratoria: Pedir consejos, guía o supervisión verbal a LA EMPRESA no anula este 40%. Solo se considerará "intervención" (y afectará el porcentaje) si LA EMPRESA debe tomar las herramientas para ejecutar el trabajo físico o para resolver un daño ocasionado durante el proceso.'],
          ['Certificación Interna: ', 'Solo tras superar exitosamente pruebas prácticas en chatarra, LA EMPRESA autorizará a EL ASOCIADO a realizar estas soldaduras en equipos de clientes bajo supervisión.']
        ];

        f3Bullets.forEach(([boldPart, textPart]) => {
          doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text('• ' + boldPart, { continued: true });
          doc.font('Helvetica').text(textPart, { align: 'justify', lineGap: 2 });
          doc.moveDown(0.4);
        });

        doc.moveDown(0.8);

        // CLÁUSULAS DE PROTECCIÓN EMPRESARIAL
        const clauY = doc.y;
        doc.rect(45, clauY, 3, 14).fill('#000000');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10.5).text('CLÁUSULAS DE PROTECCIÓN EMPRESARIAL Y CONFIDENCIALIDAD', 54, clauY + 1.5);
        doc.moveDown(0.8);

        doc.fillColor('#000000').font('Helvetica').fontSize(9).text(
          `Para proteger la integridad y los secretos comerciales de LA EMPRESA, EL ASOCIADO acepta las siguientes condiciones no negociables:`,
          { align: 'justify', lineGap: 2.5 }
        );
        doc.moveDown(0.6);

        const clauBullets = [
          ['1. Protección de Cartera (No Competencia Desleal): ', 'EL ASOCIADO conserva la plena libertad de comunicarse con sus referidos y amistades. Sin embargo, se compromete a no desviar comercialmente a dichos clientes. Queda prohibido ofrecerles reparaciones "por fuera" de manera particular, evadiendo la estructura y los canales de cobro de Doomlater.'],
          ['2. Confidencialidad de Proveedores: ', 'La identidad de los proveedores de repuestos, canales de importación mayorista y estructuras de costos de LA EMPRESA son información confidencial y no serán reveladas durante la capacitación técnica.'],
          ['3. Uso de Herramientas: ', 'El uso de la maquinaria de LA EMPRESA (microscopio, estación de calor) será exclusivo para el trabajo interno, no para uso o lucro personal de EL ASOCIADO fuera de este acuerdo.']
        ];

        clauBullets.forEach(([boldPart, textPart]) => {
          doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text(boldPart, { continued: true });
          doc.font('Helvetica').text(textPart, { align: 'justify', lineGap: 2 });
          doc.moveDown(0.5);
        });

        // PÁGINA 3
        doc.addPage();

        const p3Bullets = [
          ['4. Responsabilidad por Daños y Accidentes: ', 'Se establecen dos escenarios frente a daños en equipos de clientes:\n- Negligencia (100%): Si el daño ocurre por una intervención no autorizada o por ignorar instrucciones, EL ASOCIADO asume el 100% del costo de reposición.\n- Accidente (50/50): Si el daño es un accidente genuino ocurrido durante un procedimiento expresamente autorizado, el costo de reposición será compartido a partes iguales entre LA EMPRESA y EL ASOCIADO.\nEn cualquier caso, LA EMPRESA le responderá al cliente final, y la deuda de EL ASOCIADO le será descontada de forma progresiva (en cuotas) de sus comisiones futuras.'],
          ['5. Rendimiento y Rescisión del Acuerdo: ', 'La permanencia en este programa depende de la proactividad y los resultados comerciales. Si EL ASOCIADO incurre en inactividad injustificada, no aporta clientes o incumple las normas de este documento, LA EMPRESA se reserva el derecho de rescindir el contrato de forma inmediata y unilateral, sin derecho a indemnización.'],
          ['6. Asunción de Riesgos y Seguridad: ', 'EL ASOCIADO comprende que la manipulación de herramientas térmicas (cautines, estaciones de calor) y productos químicos implica riesgos inherentes del oficio (ej. quemaduras leves, cortaduras). EL ASOCIADO asume la responsabilidad de su integridad física al operar dichas herramientas. LA EMPRESA proveerá un ambiente de trabajo seguro y un botiquín de primeros auxilios básico, pero no asumirá gastos médicos derivados de accidentes laborales comunes ni por negligencia de EL ASOCIADO al no tomar las precauciones necesarias.']
        ];

        p3Bullets.forEach(([boldPart, textPart]) => {
          doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text(boldPart, { continued: true });
          doc.font('Helvetica').text(textPart, { align: 'justify', lineGap: 2.5 });
          doc.moveDown(0.8);
        });
      } else {
        // ------------------------------------------------------------------------
        // MODELO CONTRATO DE SERVICIO TÉCNICO Y GARANTÍA OFICIAL
        // ------------------------------------------------------------------------
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(14).text(title, { align: 'center' });
        doc.moveDown(0.6);
        doc.moveTo(45, doc.y).lineTo(567, doc.y).lineWidth(1).strokeColor('#000000').stroke();
        doc.moveDown(0.8);

        doc.fillColor('#000000').font('Helvetica').fontSize(9.5).text(
          `El presente documento certifica los términos de prestación de servicio técnico y condiciones de garantía entre Doomlater (en adelante "LA EMPRESA") y ${personName}, titular de la C.I. ${personId} (en adelante "${role}"), respecto a los equipos consignados para intervención técnica especializada.`,
          { align: 'justify', lineGap: 3 }
        );
        doc.moveDown(1.2);

        // FASE 1
        const s1BarY = doc.y;
        doc.rect(45, s1BarY, 3, 14).fill('#000000');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10.5).text('1. RECEPCIÓN, DIAGNÓSTICO Y ALCANCE TÉCNICO', 54, s1BarY + 1.5);
        doc.moveDown(0.8);

        const s1Bullets = [
          ['Inspección de Entrada: ', 'Los equipos son recibidos para evaluación técnica, pruebas funcionales de encendido, lectura, puertos y componentes.'],
          ['Mano de Obra y Repuestos: ', 'Toda intervención técnica se realiza con insumos y componentes certificados (soldadura microelectrónica, reemplazo de puertos, pastillas térmicas de alta disipación y refacciones originales).'],
          ['Presupuesto Fijo: ', 'El costo del servicio acordado cubre la totalidad del trabajo y no sufrirá variaciones no autorizadas por el cliente.']
        ];
        s1Bullets.forEach(([boldPart, textPart]) => {
          doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text('• ' + boldPart, { continued: true });
          doc.font('Helvetica').text(textPart, { align: 'justify', lineGap: 2 });
          doc.moveDown(0.4);
        });

        doc.moveDown(0.8);

        // FASE 2
        const s2BarY = doc.y;
        doc.rect(45, s2BarY, 3, 14).fill('#000000');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10.5).text('2. POLÍTICA DE GARANTÍA LIMITADA OFICIAL', 54, s2BarY + 1.5);
        doc.moveDown(0.8);

        const s2Bullets = [
          ['Cobertura de 30 Días: ', 'LA EMPRESA otorga una garantía de 30 días continuos a partir de la entrega sobre los repuestos instalados y la mano de obra intervenida.'],
          ['Pruebas de Calidad: ', 'El equipo es entregado debidamente testeado en laboratorio técnico en presencia o conformidad del cliente.'],
          ['Conservación de Comprobante: ', 'La validez de este contrato se respalda con el recibo digital oficial emitido por ItsDoomlater.']
        ];
        s2Bullets.forEach(([boldPart, textPart]) => {
          doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9).text('• ' + boldPart, { continued: true });
          doc.font('Helvetica').text(textPart, { align: 'justify', lineGap: 2 });
          doc.moveDown(0.4);
        });

        doc.moveDown(0.8);

        // RECUADRO NOTA ESTRICTA CON BORDE ROJO
        const alertY = doc.y;
        const alertW = 522;
        const alertH = 46;
        doc.rect(45, alertY, alertW, alertH).lineWidth(0.6).strokeColor('#E2E8F0').stroke();
        doc.rect(45, alertY, 3.5, alertH).fill('#DC2626');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8.2).text('EXCLUSIONES DE GARANTÍA: ', 54, alertY + 8, { continued: true });
        doc.font('Helvetica').text(
          'La garantía queda estrictamente sin efecto si el equipo presenta signos de caídas, golpes, humedad o sulfatación posterior, fluctuaciones eléctricas o intervención y apertura por terceros ajenos al equipo técnico de Doomlater.',
          { width: alertW - 16, align: 'justify', lineGap: 2 }
        );
      }

      // ------------------------------------------------------------------------
      // FIRMAS AL FINAL (Ambos modelos)
      // ------------------------------------------------------------------------
      const sigY = 530;
      const sigLineW = 200;

      // Firma Doomlater
      doc.moveTo(60, sigY).lineTo(60 + sigLineW, sigY).lineWidth(0.8).strokeColor('#000000').stroke();
      doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10).text('Doomlater', 60, sigY + 8, { width: sigLineW, align: 'center' });
      doc.font('Helvetica').fontSize(8.5).text('Director / LA EMPRESA', 60, sigY + 22, { width: sigLineW, align: 'center' });

      // Firma Asociado / Cliente
      const sig2X = 310;
      doc.moveTo(sig2X, sigY).lineTo(sig2X + sigLineW, sigY).lineWidth(0.8).strokeColor('#000000').stroke();
      doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10).text(personName, sig2X, sigY + 8, { width: sigLineW, align: 'center' });
      doc.font('Helvetica').fontSize(8.5).text(`C.I. ${personId}`, sig2X, sigY + 22, { width: sigLineW, align: 'center' });
      doc.font('Helvetica').fontSize(8.5).text(roleFull, sig2X, sigY + 34, { width: sigLineW, align: 'center' });

      // ------------------------------------------------------------------------
      // PIE DE PÁGINAS CORRIDO EN TODAS LAS HOJAS
      // ------------------------------------------------------------------------
      const totalPages = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        const footerY = 745;
        doc.fillColor('#64748B').font('Helvetica').fontSize(7.5);
        doc.text(footerSubtitle, 45, footerY, { align: 'left' });
        doc.text(`Página ${i + 1} de ${totalPages}`, 45, footerY, { width: 522, align: 'right' });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
